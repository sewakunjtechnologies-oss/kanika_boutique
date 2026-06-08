import axios from 'axios';
import { prisma } from '@kda/db';
import { env } from '../config/env';
import { logger } from '../logger';
import { storage } from '../storage';
import { createTextPdf } from './pdfDocument';

const PRINTNODE_API = 'https://api.printnode.com';

export type PrintSourceType = 'WHATSAPP_ORDER' | 'WHATSAPP_STICKER' | 'MANUAL_RECEIPT';

export interface PrintResult {
  ok: true;
  mode: 'manual' | 'printnode';
  pdfUrl: string;
  printJobId: number | null;
  message: string;
}

export async function printOrder(orderId: string): Promise<PrintResult> {
  return printSource({ sourceType: 'WHATSAPP_ORDER', sourceId: orderId });
}

export async function printManualReceipt(manualReceiptId: string): Promise<PrintResult> {
  return printSource({ sourceType: 'MANUAL_RECEIPT', sourceId: manualReceiptId });
}

export async function printSource(input: {
  sourceType: PrintSourceType;
  sourceId: string;
}): Promise<PrintResult> {
  const payload = await buildPdfPayload(input);
  const storedPath = await storage.save(
    payload.pdf,
    `prints/${input.sourceType.toLowerCase()}/${input.sourceId}-${Date.now()}.pdf`,
    'application/pdf',
  );
  const pdfUrl = `/api/uploads/${storedPath}`;
  const printerId = getPrinterId(input.sourceType);

  if (!canUsePrintNode(printerId)) {
    return {
      ok: true,
      mode: 'manual',
      pdfUrl,
      printJobId: null,
      message: 'PDF generated. Printer is not connected yet.',
    };
  }

  try {
    const printJobId = await submitPrintJob(payload.title, payload.pdf.toString('base64'), printerId, {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    return {
      ok: true,
      mode: 'printnode',
      pdfUrl,
      printJobId,
      message: 'PDF generated and print job sent.',
    };
  } catch (err) {
    logger.error({ err, sourceType: input.sourceType, sourceId: input.sourceId }, 'PrintNode failed; PDF fallback kept');
    return {
      ok: true,
      mode: 'manual',
      pdfUrl,
      printJobId: null,
      message: 'PDF generated. Printer is not connected yet.',
    };
  }
}

export function canUsePrintNode(printerId: string | undefined): boolean {
  return isPrintNodeReady({
    PRINT_PROVIDER: env.PRINT_PROVIDER,
    PRINTNODE_API_KEY: env.PRINTNODE_API_KEY,
    printerId,
  });
}

export function isPrintNodeReady(config: {
  PRINT_PROVIDER: 'manual' | 'printnode';
  PRINTNODE_API_KEY: string;
  printerId: string | undefined;
}): boolean {
  return Boolean(config.PRINT_PROVIDER === 'printnode' && config.PRINTNODE_API_KEY && config.printerId);
}

async function buildPdfPayload(input: {
  sourceType: PrintSourceType;
  sourceId: string;
}): Promise<{ title: string; pdf: Buffer }> {
  if (input.sourceType === 'MANUAL_RECEIPT') {
    const receipt = await prisma.manualReceipt.findUnique({
      where: { id: input.sourceId },
      include: {
        createdBy: { select: { name: true, email: true } },
        items: {
          include: {
            variant: { include: { product: { select: { name: true, sku: true } } } },
          },
        },
      },
    });
    if (!receipt) throw new Error(`manual receipt ${input.sourceId} not found`);
    return {
      title: receipt.receiptNumber,
      pdf: createTextPdf([
        await getBusinessName(),
        `Receipt: ${receipt.receiptNumber}`,
        `Date: ${formatDate(receipt.createdAt)}`,
        `Customer: ${receipt.customerName || 'Walk-in customer'}`,
        `Phone: ${receipt.customerPhone || '-'}`,
        `Created by: ${receipt.createdBy?.name || receipt.createdBy?.email || '-'}`,
        '',
        'Items',
        ...receipt.items.map((item) =>
          `${item.variant.product.sku} - ${item.variant.product.name} / size ${item.variant.size} x ${item.quantity} @ Rs ${formatAmount(item.unitPrice)}`,
        ),
        '',
        `Subtotal: Rs ${formatAmount(receipt.subtotal)}`,
        `Delivery: Rs ${formatAmount(receipt.deliveryCharge)}`,
        `Discount: Rs ${formatAmount(receipt.discount)}`,
        `Total: Rs ${formatAmount(receipt.totalAmount)}`,
        `Payment: ${receipt.paymentMode}`,
        receipt.notes ? `Notes: ${receipt.notes}` : '',
      ]),
    };
  }

  const order = await prisma.order.findUnique({
    where: { id: input.sourceId },
    include: {
      customer: { select: { whatsappNumber: true, name: true } },
      approvedBy: { select: { name: true, email: true } },
      items: {
        include: {
          variant: { include: { product: { select: { name: true, sku: true } } } },
        },
      },
    },
  });
  if (!order) throw new Error(`order ${input.sourceId} not found`);

  const common = [
    await getBusinessName(),
    `${input.sourceType === 'WHATSAPP_STICKER' ? 'Sticker' : 'Order'}: ${order.orderNumber}`,
    `Date: ${formatDate(order.createdAt)}`,
    `Customer: ${order.shippingName}`,
    `WhatsApp: ${order.customer.whatsappNumber}`,
    `Approved by: ${order.approvedBy?.name || order.approvedBy?.email || '-'}`,
    '',
  ];

  if (input.sourceType === 'WHATSAPP_STICKER') {
    return {
      title: `${order.orderNumber}-sticker`,
      pdf: createTextPdf([
        ...common,
        'Delivery address',
        order.shippingName,
        order.shippingAddress,
        `${order.shippingCity}, ${order.shippingState} - ${order.shippingPincode}`,
        '',
        `Order total: Rs ${formatAmount(order.totalAmount)}`,
      ]),
    };
  }

  return {
    title: order.orderNumber,
    pdf: createTextPdf([
      ...common,
      'Items',
      ...order.items.map((item) =>
        `${item.variant.product.sku} - ${item.variant.product.name} / size ${item.variant.size} x ${item.quantity} @ Rs ${formatAmount(item.unitPrice)}`,
      ),
      '',
      `Subtotal: Rs ${formatAmount(order.subtotal)}`,
      `Delivery: Rs ${formatAmount(order.shippingFee)}`,
      `Total: Rs ${formatAmount(order.totalAmount)}`,
      `Payment status: ${order.paymentVerifiedAt ? 'VERIFIED' : order.status}`,
      '',
      'Delivery address',
      order.shippingName,
      order.shippingAddress,
      `${order.shippingCity}, ${order.shippingState} - ${order.shippingPincode}`,
    ]),
  };
}

async function submitPrintJob(
  title: string,
  contentBase64: string,
  printerIdValue: string | undefined,
  logContext: Record<string, unknown>,
): Promise<number> {
  const printerId = Number.parseInt(printerIdValue ?? '', 10);
  if (Number.isNaN(printerId)) {
    throw new Error(`printer ID is not a number: ${printerIdValue}`);
  }

  const resp = await axios.post<number>(
    `${PRINTNODE_API}/printjobs`,
    {
      printerId,
      title,
      contentType: 'pdf_base64',
      content: contentBase64,
      source: 'kda-boutique',
    },
    {
      auth: { username: env.PRINTNODE_API_KEY, password: '' },
      timeout: 20_000,
    },
  );
  logger.info({ ...logContext, printJobId: resp.data }, 'print job submitted');
  return resp.data;
}

function getPrinterId(sourceType: PrintSourceType): string | undefined {
  if (sourceType === 'WHATSAPP_STICKER') return env.LABEL_PRINTER_ID || env.PRINTNODE_PRINTER_ID;
  if (sourceType === 'MANUAL_RECEIPT') return env.RECEIPT_PRINTER_ID || env.PRINTNODE_PRINTER_ID;
  return env.INVOICE_PRINTER_ID || env.PRINTNODE_PRINTER_ID;
}

async function getBusinessName(): Promise<string> {
  const businessNameSetting = await prisma.setting.findUnique({ where: { key: 'business_name' } });
  return businessNameSetting?.value ?? env.BUSINESS_NAME;
}

function formatAmount(value: { toString(): string } | number): string {
  return Number(value.toString()).toFixed(0);
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

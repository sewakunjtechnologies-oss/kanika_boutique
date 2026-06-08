import QRCode from 'qrcode';
import type { Customer, ManualReceipt, ManualReceiptItem, Order, OrderItem, Product, ProductVariant } from '@kda/db';

export interface OrderForSlip extends Order {
  customer: Pick<Customer, 'whatsappNumber' | 'name'>;
  items: (OrderItem & {
    variant: ProductVariant & { product: Pick<Product, 'name' | 'sku'> };
  })[];
}

export async function renderSlipHtml(
  order: OrderForSlip,
  settings: { businessName: string },
): Promise<string> {
  const qr = await QRCode.toDataURL(order.orderNumber, { width: 120, margin: 0 });
  const itemsHtml = order.items
    .map(
      (i) => `
        <tr>
          <td class="sku">${escape(i.variant.product.sku)}</td>
          <td>${escape(i.variant.product.name)}<br/><span class="small">size ${escape(i.variant.size)}${i.variant.color ? ` · ${escape(i.variant.color)}` : ''}</span></td>
          <td class="num">${i.quantity}</td>
          <td class="num">₹${Number(i.unitPrice).toFixed(0)}</td>
          <td class="num">₹${(Number(i.unitPrice) * i.quantity).toFixed(0)}</td>
        </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; font-size: 11px; width: 72mm; margin: 0; padding: 0; color: #000; }
  .header { text-align: center; }
  .header h1 { font-size: 16px; margin: 0 0 2px; letter-spacing: 1px; }
  .header .order { font-size: 13px; font-weight: bold; margin: 4px 0; }
  .small { font-size: 9px; color: #444; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .num { text-align: right; }
  .totals td { padding: 1px 0; }
  .total-row td { border-top: 1px solid #000; padding-top: 3px; font-weight: bold; }
  .qr { text-align: center; margin-top: 6px; }
  .footer { text-align: center; margin-top: 6px; font-size: 9px; color: #555; }
</style>
</head><body>
<div class="header">
  <h1>${escape(settings.businessName)}</h1>
  <div class="small">${formatDate(order.createdAt)}</div>
  <div class="order">${escape(order.orderNumber)}</div>
</div>
<hr/>
<div>
  <strong>${escape(order.shippingName)}</strong><br/>
  <span class="small">${escape(order.customer.whatsappNumber)}</span><br/>
  ${escape(order.shippingAddress)}<br/>
  ${escape(order.shippingCity)}, ${escape(order.shippingState)} - ${escape(order.shippingPincode)}
</div>
<hr/>
<table>
  <thead><tr><td class="small">SKU</td><td class="small">Item</td><td class="small num">Qty</td><td class="small num">Rate</td><td class="small num">Amt</td></tr></thead>
  <tbody>${itemsHtml}</tbody>
</table>
<hr/>
<table class="totals">
  <tr><td>Subtotal</td><td class="num">₹${Number(order.subtotal).toFixed(0)}</td></tr>
  <tr><td>Shipping</td><td class="num">₹${Number(order.shippingFee).toFixed(0)}</td></tr>
  <tr class="total-row"><td>Total</td><td class="num">₹${Number(order.totalAmount).toFixed(0)}</td></tr>
</table>
<div class="qr"><img src="${qr}" width="100" height="100" alt="qr"/></div>
<div class="footer">Thank you for shopping with us!</div>
</body></html>`;
}

export interface ManualReceiptForSlip extends ManualReceipt {
  items: (ManualReceiptItem & {
    variant: ProductVariant & { product: Pick<Product, 'name' | 'sku'> };
  })[];
}

export async function renderManualReceiptHtml(
  receipt: ManualReceiptForSlip,
  settings: { businessName: string },
): Promise<string> {
  const qr = await QRCode.toDataURL(receipt.receiptNumber, { width: 120, margin: 0 });
  const itemsHtml = receipt.items
    .map(
      (i) => `
        <tr>
          <td class="sku">${escape(i.variant.product.sku)}</td>
          <td>${escape(i.variant.product.name)}<br/><span class="small">size ${escape(i.variant.size)}${i.variant.color ? ` · ${escape(i.variant.color)}` : ''}</span></td>
          <td class="num">${i.quantity}</td>
          <td class="num">₹${Number(i.unitPrice).toFixed(0)}</td>
          <td class="num">₹${(Number(i.unitPrice) * i.quantity).toFixed(0)}</td>
        </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; font-size: 11px; width: 72mm; margin: 0; padding: 0; color: #000; }
  .header { text-align: center; }
  .header h1 { font-size: 16px; margin: 0 0 2px; letter-spacing: 1px; }
  .header .order { font-size: 13px; font-weight: bold; margin: 4px 0; }
  .small { font-size: 9px; color: #444; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .num { text-align: right; }
  .totals td { padding: 1px 0; }
  .total-row td { border-top: 1px solid #000; padding-top: 3px; font-weight: bold; }
  .qr { text-align: center; margin-top: 6px; }
  .footer { text-align: center; margin-top: 6px; font-size: 9px; color: #555; }
</style>
</head><body>
<div class="header">
  <h1>${escape(settings.businessName)}</h1>
  <div class="small">${formatDate(receipt.createdAt)}</div>
  <div class="order">${escape(receipt.receiptNumber)}</div>
</div>
<hr/>
<div>
  <strong>${escape(receipt.customerName || 'Walk-in customer')}</strong><br/>
  <span class="small">${escape(receipt.customerPhone || '')}</span><br/>
  <span class="small">Payment: ${escape(receipt.paymentMode)}</span>
</div>
<hr/>
<table>
  <thead><tr><td class="small">SKU</td><td class="small">Item</td><td class="small num">Qty</td><td class="small num">Rate</td><td class="small num">Amt</td></tr></thead>
  <tbody>${itemsHtml}</tbody>
</table>
<hr/>
<table class="totals">
  <tr><td>Subtotal</td><td class="num">₹${Number(receipt.subtotal).toFixed(0)}</td></tr>
  <tr><td>Delivery</td><td class="num">₹${Number(receipt.deliveryCharge).toFixed(0)}</td></tr>
  <tr><td>Discount</td><td class="num">₹${Number(receipt.discount).toFixed(0)}</td></tr>
  <tr class="total-row"><td>Total</td><td class="num">₹${Number(receipt.totalAmount).toFixed(0)}</td></tr>
</table>
${receipt.notes ? `<hr/><div class="small">${escape(receipt.notes)}</div>` : ''}
<div class="qr"><img src="${qr}" width="100" height="100" alt="qr"/></div>
<div class="footer">Thank you for shopping with us!</div>
</body></html>`;
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

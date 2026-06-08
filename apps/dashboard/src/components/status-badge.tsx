import { Badge } from '@/components/ui/badge';

export function StatusBadge({ status }: { status: string }): React.ReactElement {
  const variant: 'default' | 'success' | 'destructive' | 'warning' | 'secondary' =
    status === 'VERIFIED' || status === 'PRINTED' || status === 'DISPATCHED'
      ? 'success'
      : status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED'
        ? 'destructive'
        : status === 'PAYMENT_RECEIVED' || status === 'PAYMENT_REVIEW'
          ? 'warning'
          : 'secondary';
  return <Badge variant={variant}>{status}</Badge>;
}

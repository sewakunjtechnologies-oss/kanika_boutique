'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

const FIELDS = [
  { key: 'business_name', label: 'Business name' },
  { key: 'upi_id', label: 'UPI ID' },
  { key: 'shipping_fee', label: 'Default shipping fee (₹)' },
  { key: 'working_hours_start', label: 'Working hours start' },
  { key: 'working_hours_end', label: 'Working hours end' },
] as const;

const TEMPLATES = [
  { key: 'greeting_template', label: 'Greeting message' },
  { key: 'away_template', label: 'Away message' },
  { key: 'order_confirmation_template', label: 'Order confirmation' },
  { key: 'payment_rejection_template', label: 'Payment rejection' },
] as const;

export default function SettingsPage(): React.ReactElement {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.get<{ settings: Record<string, string> }>('/api/settings').then((r) => setSettings(r.settings));
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await api.put('/api/settings', { settings });
      toast.success('Settings saved');
    } catch {
      toast.error('Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Business</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-2">
              <Label>{f.label}</Label>
              <Input
                value={settings[f.key] ?? ''}
                onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Message templates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {TEMPLATES.map((t) => (
            <div key={t.key} className="space-y-2">
              <Label>{t.label}</Label>
              <textarea
                value={settings[t.key] ?? ''}
                onChange={(e) => setSettings({ ...settings, [t.key]: e.target.value })}
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Button onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save settings'}
      </Button>
    </div>
  );
}

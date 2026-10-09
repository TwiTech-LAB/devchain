import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ToastAction } from '@/ui/components/ui/toast';
import { HOME_BACKEND } from '@/ui/lib/api-transport';
import { persistCloudTarget } from '@/ui/lib/cloud-target';
import {
  exactTopic,
  type RealtimeInvalidationRegistry,
} from '@/ui/lib/realtime-invalidation-registry';
import { useToast } from './use-toast';
import { useRealtimeDispatch } from './useRealtimeDispatch';

export function useUnsignedDeviceNotice(): void {
  const { toast } = useToast();
  const navigate = useNavigate();
  const registry = useMemo<RealtimeInvalidationRegistry>(
    () => [
      {
        match: exactTopic('cloud'),
        type: 'e2ee_unsigned_device_added',
        entries: [
          {
            kind: 'custom-handler',
            handler: (payload) => {
              if (typeof payload.kid !== 'string' || !payload.kid) return;
              const label =
                typeof payload.label === 'string' && payload.label.trim()
                  ? payload.label
                  : 'Mobile device';
              toast({
                title: 'Unsigned phone added',
                description: `A phone was added without a signed enrollment: ${label}. Review it in Account → Paired devices.`,
                action: (
                  <ToastAction
                    altText="Review this PC's paired devices"
                    onClick={() => {
                      persistCloudTarget({ backend: HOME_BACKEND, remoteName: null });
                      navigate('/cloud?section=account');
                    }}
                  >
                    Review devices
                  </ToastAction>
                ),
              });
            },
          },
        ],
      },
    ],
    [navigate, toast],
  );

  useRealtimeDispatch(registry, { socket: 'home' });
}

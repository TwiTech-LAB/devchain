import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastTitle,
  ToastViewport,
} from '@/ui/components/ui/toast';
import { useToast } from '@/ui/hooks/use-toast';

export function Toaster() {
  const { toasts, dismiss } = useToast();

  return (
    <>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast
            key={id}
            {...props}
            onClick={(event) => {
              props.onClick?.(event);
              if (!event.defaultPrevented) {
                dismiss(id);
              }
            }}
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </>
  );
}

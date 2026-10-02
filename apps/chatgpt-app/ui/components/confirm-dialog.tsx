import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Button } from "./button.tsx";

type Props = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

/** shadcn alert-dialog composition. Cancel takes focus so the dangerous action is not the default. */
export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel, danger = false, onOpenChange, onConfirm }: Props) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="px-overlay" />
      <AlertDialog.Content className="px-dialog">
        <AlertDialog.Title className="px-dialog-title">{title}</AlertDialog.Title>
        <AlertDialog.Description className="px-dialog-copy">{description}</AlertDialog.Description>
        <div className="actions">
          <AlertDialog.Cancel asChild><Button variant="primary">{cancelLabel}</Button></AlertDialog.Cancel>
          <AlertDialog.Action asChild><Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

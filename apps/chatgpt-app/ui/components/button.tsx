import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps } from "react";

type Variant = "primary" | "quiet" | "danger";
type Props = ComponentProps<"button"> & { variant?: Variant; asChild?: boolean };

/** shadcn button composition: one Slot, one native button, variant classes. */
export function Button({ variant = "quiet", asChild = false, className, type, ...props }: Props) {
  const Comp = asChild ? Slot : "button";
  const classes = ["px-btn", `px-${variant}`, className].filter(Boolean).join(" ");
  return <Comp className={classes} type={asChild ? type : type ?? "button"} {...props} />;
}

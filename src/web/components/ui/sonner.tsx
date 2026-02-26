import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      richColors
      closeButton
      expand
      visibleToasts={6}
      toastOptions={{
        duration: 8000,
        style: {
          border: "1px solid hsl(var(--border))",
          background: "hsl(var(--card))",
          color: "hsl(var(--card-foreground))",
        },
      }}
    />
  );
}

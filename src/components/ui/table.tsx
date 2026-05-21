import { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        "border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500",
        className
      )}
      {...props}
    />
  );
}
export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-ink-100", className)} {...props} />;
}
export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("hover:bg-ink-50/50", className)} {...props} />;
}
export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("px-3 py-2 text-left font-medium", className)} {...props} />;
}
export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2 align-top", className)} {...props} />;
}

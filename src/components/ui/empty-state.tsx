import { cn } from "@/lib/utils/cn";

export function EmptyState({
  title,
  description,
  className,
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-ink-200 bg-ink-50/50 px-6 py-10 text-center",
        className
      )}
    >
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {description && <p className="text-xs text-ink-500">{description}</p>}
    </div>
  );
}

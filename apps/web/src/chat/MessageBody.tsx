export function MessageBody({ body }: { body: string }) {
  const parts = body.split(/(https?:\/\/[^\s<>"']+)/gi);
  return (
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {parts.map((part, index) => {
        if (!/^https?:\/\//i.test(part)) return part;
        try {
          const url = new URL(part);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            return part;
          return (
            <a
              key={index}
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline decoration-primary/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {part}
            </a>
          );
        } catch {
          return part;
        }
      })}
    </p>
  );
}

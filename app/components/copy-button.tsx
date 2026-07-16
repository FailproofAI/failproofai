"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

function fallbackCopyText(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const showCopied = useCallback(() => {
    clearTimeout(timeoutRef.current);
    setCopied(true);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (!fallbackCopyText(text)) {
        throw new Error("Both clipboard methods failed");
      }
      showCopied();
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
      try {
        if (fallbackCopyText(text)) {
          showCopied();
        }
      } catch {
        // Both methods failed — do nothing
      }
    }
  }, [text, showCopied]);

  return (
    <button type="button"
      onClick={handleCopy}
      title="Copy to clipboard"
      className={cn(
        "inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors",
        className
      )}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green-500" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

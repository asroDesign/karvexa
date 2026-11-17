"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Eye,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Underline,
  Undo2,
  Upload,
} from "lucide-react";
import { sanitizeRichHtml } from "@/lib/sanitize-html";

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

export function RichTextEditor({ value, onChange, placeholder }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<"visual" | "html" | "preview">("visual");
  const [showImageDialog, setShowImageDialog] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageAlt, setImageAlt] = useState("");
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");

  // Synchronize external value updates when switching articles
  useEffect(() => {
    if (mode === "visual" && editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value || "";
    }
  }, [value, mode]);

  function exec(command: string, arg?: string) {
    if (mode !== "visual") return;
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
  }

  function insertHtmlSnippet(snippet: string) {
    if (mode === "visual") {
      editorRef.current?.focus();
      document.execCommand("insertHTML", false, snippet);
      if (editorRef.current) onChange(editorRef.current.innerHTML);
    } else {
      onChange(`${value}\n${snippet}`);
    }
  }

  function handleInsertImageUrl() {
    if (!imageUrl.trim()) return;
    const safeUrl = imageUrl.trim().replace(/"/g, "&quot;");
    const safeAlt = (imageAlt.trim() || "تصویر آموزشی").replace(/"/g, "&quot;");
    insertHtmlSnippet(`<figure><img src="${safeUrl}" alt="${safeAlt}" /></figure><p></p>`);
    setImageUrl("");
    setImageAlt("");
    setShowImageDialog(false);
  }

  function handleUploadImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert("حداکثر حجم تصویر برای درج مستقیم ۲ مگابایت است.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      if (dataUrl.startsWith("data:image/")) {
        insertHtmlSnippet(
          `<figure><img src="${dataUrl}" alt="${file.name.replace(/"/g, "")}" /></figure><p></p>`
        );
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleInsertLink() {
    if (!linkUrl.trim()) return;
    const safeHref = linkUrl.trim().replace(/"/g, "&quot;");
    const label = (linkText.trim() || safeHref).replace(/</g, "&lt;");
    insertHtmlSnippet(`<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    setLinkUrl("");
    setLinkText("");
    setShowLinkDialog(false);
  }

  const tools: Array<{
    title: string;
    icon: React.ComponentType<{ className?: string }>;
    action: () => void;
  }> = [
    { title: "تیتر اصلی (H2)", icon: Heading2, action: () => exec("formatBlock", "<h2>") },
    { title: "زیرتیتر (H3)", icon: Heading3, action: () => exec("formatBlock", "<h3>") },
    { title: "بولد (Bold)", icon: Bold, action: () => exec("bold") },
    { title: "ایتالیک (Italic)", icon: Italic, action: () => exec("italic") },
    { title: "زیرخط (Underline)", icon: Underline, action: () => exec("underline") },
    { title: "لیست نقطه‌ای", icon: List, action: () => exec("insertUnorderedList") },
    { title: "لیست شماره‌دار", icon: ListOrdered, action: () => exec("insertOrderedList") },
    {
      title: "نقل‌قول / کادر نکته کلیدی",
      icon: Quote,
      action: () =>
        insertHtmlSnippet(
          `<blockquote><strong>نکته کلیدی:</strong> متن نکته آموزشی خود را اینجا بنویسید.</blockquote><p></p>`
        ),
    },
    {
      title: "کد / دستور فنی",
      icon: Code,
      action: () => insertHtmlSnippet(`<code>API_KEY</code> `),
    },
    { title: "راست‌چین", icon: AlignRight, action: () => exec("justifyRight") },
    { title: "وسط‌چین", icon: AlignCenter, action: () => exec("justifyCenter") },
    { title: "چپ‌چین", icon: AlignLeft, action: () => exec("justifyLeft") },
    { title: "درج لینک", icon: Link2, action: () => setShowLinkDialog(!showLinkDialog) },
    { title: "درج تصویر از لینک", icon: ImageIcon, action: () => setShowImageDialog(!showImageDialog) },
    { title: "آپلود تصویر از سیستم", icon: Upload, action: () => fileInputRef.current?.click() },
    { title: "بازگردانی (Undo)", icon: Undo2, action: () => exec("undo") },
    { title: "تکرار (Redo)", icon: Redo2, action: () => exec("redo") },
  ];

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white/80 dark:bg-slate-900/70">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50/90 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap items-center gap-1">
          {tools.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.title}
                type="button"
                title={t.title}
                onClick={t.action}
                className="h-8 w-8 rounded-lg hover:bg-violet-500/15 hover:text-violet-700 dark:hover:text-violet-300 flex items-center justify-center text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleUploadImageFile}
          />
        </div>

        {/* Mode Switcher */}
        <div className="inline-flex rounded-lg bg-slate-200/70 dark:bg-slate-900/80 p-0.5 text-[11px]">
          {(
            [
              { id: "visual", label: "ویرایشگر دیداری" },
              { id: "preview", label: "پیش‌نمایش" },
              { id: "html", label: "کد HTML" },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                mode === m.id
                  ? "bg-violet-600 text-white shadow-xs"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Inline Insert Image Dialog */}
      {showImageDialog && (
        <div className="p-3 bg-violet-50/70 dark:bg-violet-950/30 border-b border-violet-200/60 flex flex-wrap items-center gap-2 text-xs">
          <input
            dir="ltr"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://... یا /images/academy-accounting.png"
            className="flex-1 min-w-[200px] glass-input px-3 py-1.5 font-mono text-left"
          />
          <input
            value={imageAlt}
            onChange={(e) => setImageAlt(e.target.value)}
            placeholder="توضیح تصویر (Alt)"
            className="w-44 glass-input px-3 py-1.5"
          />
          <button
            type="button"
            onClick={handleInsertImageUrl}
            className="rounded-lg bg-violet-600 text-white px-3 py-1.5 font-medium cursor-pointer"
          >
            درج تصویر
          </button>
        </div>
      )}

      {/* Inline Insert Link Dialog */}
      {showLinkDialog && (
        <div className="p-3 bg-sky-50/70 dark:bg-sky-950/30 border-b border-sky-200/60 flex flex-wrap items-center gap-2 text-xs">
          <input
            dir="ltr"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://..."
            className="flex-1 min-w-[200px] glass-input px-3 py-1.5 font-mono text-left"
          />
          <input
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            placeholder="متن نمایشی لینک"
            className="w-44 glass-input px-3 py-1.5"
          />
          <button
            type="button"
            onClick={handleInsertLink}
            className="rounded-lg bg-sky-600 text-white px-3 py-1.5 font-medium cursor-pointer"
          >
            درج لینک
          </button>
        </div>
      )}

      {/* Editor Body */}
      {mode === "visual" && (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={(e) => onChange(e.currentTarget.innerHTML)}
          data-placeholder={placeholder || "محتوای آموزشی کامل را اینجا بنویسید..."}
          className="bos-prose min-h-[280px] max-h-[540px] overflow-y-auto p-4 focus:outline-none"
        />
      )}

      {mode === "html" && (
        <textarea
          dir="ltr"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full min-h-[280px] p-4 font-mono text-xs bg-slate-950 text-emerald-300 focus:outline-none text-left"
        />
      )}

      {mode === "preview" && (
        <div className="p-5 min-h-[280px] max-h-[540px] overflow-y-auto">
          <div className="text-[11px] text-violet-600 mb-2 flex items-center gap-1 font-semibold">
            <Eye className="h-3.5 w-3.5" />
            <span>پیش‌نمایش ایمن‌شده (XSS Sanitized) دقیقاً مطابق نمایش در صفحه آموزش:</span>
          </div>
          <div
            className="bos-prose"
            dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(value) }}
          />
        </div>
      )}
    </div>
  );
}

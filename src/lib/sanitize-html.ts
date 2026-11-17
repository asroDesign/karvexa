/**
 * Strict server-side & client-side HTML sanitizer for Academy Rich Text Editor content.
 * Strips dangerous tags (<script>, <iframe>, <object>, <embed>, <form>, <style>),
 * inline JS event handlers (on*=), and javascript:/vbscript: URLs.
 */
export function sanitizeRichHtml(rawHtml: string): string {
  if (!rawHtml) return "";
  let clean = rawHtml;

  // 1. Remove dangerous block tags and their inner content
  clean = clean.replace(
    /<\s*(script|style|iframe|object|embed|applet|meta|link|base|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    ""
  );
  // Remove self-closing dangerous tags
  clean = clean.replace(
    /<\s*(script|style|iframe|object|embed|applet|meta|link|base|form|input|button)[^>]*\/?>/gi,
    ""
  );

  // 2. Strip inline event handlers (onclick, onerror, onload, etc.)
  clean = clean.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // 3. Neutralize javascript:, vbscript:, and non-image data: URIs in href/src
  clean = clean.replace(
    /(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript):[^"']*\2/gi,
    '$1="#"'
  );
  clean = clean.replace(
    /src\s*=\s*(["'])\s*data:(?!image\/(?:png|jpeg|jpg|webp|gif);base64,)[^"']*\1/gi,
    'src=""'
  );

  return clean.trim();
}

/** Strip model-emitted image markup; real images are separate ImageMessage / assistant_images. */
const FILE_TAG_RE = /<file\b[^>]*(?:\/>|>\s*<\/file>)/gi;
const FILE_OPEN_RE = /<file\b[^>]*>/gi;
const MD_UPLOAD_IMAGE_RE = /!\[[^\]]*]\(\s*\/api\/v1\/chat\/uploads\/[^)]+\)/gi;
/** TTS emotion cues like `[whispering]` / `[quiet]` — UI never shows them. */
const EMOTION_TAG_RE = /\[[^\[\]\n]{1,120}\](?!\()[ \t]?/g;
/**
 * Breeze 表演协议行：`<emo>` 指令只走 TTS 线路，UI/历史一律不显示。
 * 既有数据（旧版本落库的行）也靠这里兜底。
 */
const EMO_CLOSED_SPAN_RE = /<emo>[\s\S]*?<\/emo>/gi;
const EMO_LINE_RE = /^[ \t]*<emo>[^\n]*(?:\n|$)/gim;

export function stripEmotionTags(text: string): string {
  if (!text) return '';
  const normalized = text
    .replace(/［/g, '[')
    .replace(/］/g, ']')
    .replace(/【/g, '[')
    .replace(/】/g, ']');
  return normalized
    .replace(EMO_CLOSED_SPAN_RE, '')
    .replace(EMO_LINE_RE, '')
    .replace(EMOTION_TAG_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function stripEmbeddedImageMarkup(text: string): string {
  if (!text) return '';
  return stripEmotionTags(
    text
      .replace(FILE_TAG_RE, '')
      .replace(FILE_OPEN_RE, '')
      .replace(MD_UPLOAD_IMAGE_RE, ''),
  );
}

/** Sidebar / list preview: replace embedded image markup with a short placeholder. */
export function previewTextWithImagePlaceholder(text: string): string {
  if (!text) return '';
  const marked = stripEmotionTags(text)
    .replace(FILE_TAG_RE, '【图片】')
    .replace(FILE_OPEN_RE, '【图片】')
    .replace(MD_UPLOAD_IMAGE_RE, '【图片】')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return marked;
}

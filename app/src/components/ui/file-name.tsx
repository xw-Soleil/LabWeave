import { cn } from "@/utils/cn";

/** 扩展名主体(点号之后)最多这么多字符,且不含空白和点;超过就不当扩展名看待 */
const MAX_EXTENSION_LENGTH = 10;
const EXTENSION_BODY = new RegExp(`^[^\\s.]{1,${MAX_EXTENSION_LENGTH}}$`);

/**
 * 把文件名拆成「主干 + 扩展名」。
 * - 只认最后一个扩展名:`a.tar.gz` → `a.tar` + `.gz`
 * - 没有扩展名:`README` → `README` + ``
 * - 点文件:`.gitignore` → `.gitignore` + ``;`.env.local` → `.env` + `.local`
 * - 结尾是点、或点后面像一句话(含空格/过长)时不当扩展名:`v1.2 最终版` 整体是主干
 */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  // dot <= 0:没有点,或只有开头那个点(点文件)
  if (dot <= 0) return { stem: name, ext: "" };
  const body = name.slice(dot + 1);
  if (!EXTENSION_BODY.test(body)) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * 计算 FileName 实际渲染的两段:`head` 放进可截断的部分,`tail` 始终可见。
 * tailChars 按字符(码点)计,不会切开 emoji 之类的代理对;
 * 主干不比 tailChars 长时不额外保留,保证总有可截断的部分。
 */
export function fileNameParts(
  name: string,
  options: { keepExtension?: boolean; tailChars?: number } = {},
): { head: string; tail: string } {
  const { keepExtension = true, tailChars = 0 } = options;
  if (!keepExtension) return { head: name, tail: "" };
  const { stem, ext } = splitFileName(name);
  const chars = Array.from(stem);
  const keep = Math.max(0, Math.floor(tailChars));
  if (keep === 0 || chars.length <= keep) return { head: stem, tail: ext };
  return {
    head: chars.slice(0, chars.length - keep).join(""),
    tail: chars.slice(chars.length - keep).join("") + ext,
  };
}

/**
 * 长文件名的统一显示方式:中间省略、扩展名始终可见,悬停显示全名(或传入的完整路径)。
 * 放进 flex 行里也能正确收缩(自带 min-w-0)。
 */
export function FileName({
  name,
  title,
  className,
  keepExtension = true,
  tailChars = 0,
}: {
  /** 显示的名字,比如 "main.pdf" 或 "垃圾分类模型对比" */
  name: string;
  /** 悬停提示,默认等于 name;传完整路径时显示路径 */
  title?: string;
  className?: string;
  /** 默认 true:主干部分截断,扩展名始终可见 */
  keepExtension?: boolean;
  /** 除扩展名外,结尾再多保留几个字符(区分 v7_final 和 v7_final2),默认 0 */
  tailChars?: number;
}) {
  const { head, tail } = fileNameParts(name, { keepExtension, tailChars });
  return (
    <span className={cn("flex min-w-0", className)} title={title ?? name}>
      <span className="min-w-0 truncate">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
}

/** 工作区文件名去掉 `.prg` 后缀(大小写不敏感),用于标签、标题栏、欢迎页 */
export function displayWorkspaceName(fileName: string): string {
  return fileName.replace(/\.prg$/i, "");
}

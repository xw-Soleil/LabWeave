import { cn } from "@/utils/cn";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import {
  Calendar,
  CheckSquare,
  ChevronRight,
  Hash,
  Link,
  List,
  Plus,
  Tags,
  Text,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { isMap, isNode, isScalar, parseDocument, stringify } from "yaml";

/** 笔记开头 `---` 之间那段（Obsidian 叫「笔记属性」）。没有时返回 null */
export function splitFrontmatter(
  source: string,
): { opening: string; yaml: string; closing: string; body: string } | null {
  const bom = source.charCodeAt(0) === 0xfeff ? source[0] : "";
  const match = /^(---[ \t]*\r?\n)(?:([\s\S]*?)(\r?\n))?(---[ \t]*)(\r?\n|$)/.exec(source.slice(bom.length));
  if (!match) return null;
  const [whole, opening, yaml = "", newline = "", fence, end] = match;
  return {
    opening: bom + opening,
    yaml: yaml + newline,
    closing: fence + end,
    body: source.slice(bom.length + whole.length),
  };
}

/**
 * 词数和字符数，照 Obsidian 的数法（同一篇笔记实测词数只差 2）：汉字、假名一个字算一个词，
 * 字母（拉丁、希腊、西里尔）和数字连着的一串算一个词；字符数是正文的长度。笔记属性不算
 */
const WORDS = /[一-鿕ぁ-ゖゝ-ゟァ-ヺー-ヿ]|(?:[0-9]+(?:[,.][0-9]+)*|[-A-Za-zªµºÀ-ÖØ-öø-ˁͰ-ϿЀ-ԯ])+/g;
export function noteStats(source: string): { words: number; characters: number } {
  const body = splitFrontmatter(source)?.body ?? source;
  return { words: body.match(WORDS)?.length ?? 0, characters: body.length };
}

export type PropertyKind = "text" | "list" | "tags" | "number" | "checkbox" | "date" | "link" | "other";
export interface NoteProperty {
  key: string;
  value: unknown;
  kind: PropertyKind;
}

function kindOf(key: string, value: unknown): PropertyKind {
  if (/^(tags?|aliases)$/i.test(key)) return key.toLowerCase().startsWith("tag") ? "tags" : "list";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (typeof value === "string" && /^https?:\/\/\S+$/i.test(value)) return "link";
  if (value === null || value === undefined || typeof value === "string") return "text";
  return "other";
}

/** 读出每一项；格式坏了返回 null，界面就按原文显示，不去猜 */
export function parseNoteProperties(yaml: string): NoteProperty[] | null {
  if (!yaml.trim()) return [];
  const document = parseDocument(yaml, { prettyErrors: false });
  if (document.errors.length || !isMap(document.contents)) return null;
  return document.contents.items.flatMap((pair) => {
    if (!isScalar(pair.key)) return [];
    const key = String(pair.key.value);
    const value = isNode(pair.value) ? pair.value.toJSON() : pair.value;
    return [{ key, value, kind: kindOf(key, value) }];
  });
}

function formatScalar(value: unknown): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

function formatField(key: string, value: unknown, newline: string): string {
  const name = formatScalar(key);
  if (Array.isArray(value))
    return value.length
      ? `${name}:${newline}${value.map((entry) => `  - ${formatScalar(entry)}`).join(newline)}${newline}`
      : `${name}: []${newline}`;
  if (value === null || value === undefined || value === "") return `${name}:${newline}`;
  return `${name}: ${formatScalar(value)}${newline}`;
}

/**
 * 只替换改动的那一项（或在末尾加一项、删掉一项），其他项的原始写法、注释、引号都不动。
 * value 为 undefined 表示删除这一项。
 */
export function setNoteProperty(yaml: string, key: string, value: unknown): string {
  const document = parseDocument(yaml, { prettyErrors: false });
  if (document.errors.length || (yaml.trim() && !isMap(document.contents))) throw new Error("propertiesInvalid");
  const newline = yaml.includes("\r\n") ? "\r\n" : "\n";
  const replacement = value === undefined ? "" : formatField(key, value, newline);
  const pair = isMap(document.contents)
    ? document.contents.items.find((entry) => isScalar(entry.key) && String(entry.key.value) === key)
    : undefined;
  let result: string;
  if (pair && isScalar(pair.key) && pair.key.range) {
    const start = pair.key.range[0];
    let end = isNode(pair.value) && pair.value.range ? pair.value.range[2] : pair.key.range[2];
    if (end > 0 && yaml[end - 1] !== "\n") {
      const lineEnd = yaml.indexOf("\n", end);
      end = lineEnd < 0 ? yaml.length : lineEnd + 1;
    }
    result = yaml.slice(0, start) + replacement + yaml.slice(end);
  } else {
    if (value === undefined) return yaml;
    const base = yaml && !yaml.endsWith("\n") ? yaml + newline : yaml;
    result = base + replacement;
  }
  if (parseNoteProperties(result) === null) throw new Error("propertiesInvalid");
  return result;
}

const KIND_ICONS: Record<PropertyKind, LucideIcon> = {
  text: Text,
  list: List,
  tags: Tags,
  number: Hash,
  checkbox: CheckSquare,
  date: Calendar,
  link: Link,
  other: Text,
};
const COLLAPSED_KEY = "labweave.propertiesCollapsed";
const text = (key: string) => i18next.t(`noteProperties.${key}`, { ns: "research" });

/**
 * 照 Obsidian 的「笔记属性」：一项一行，图标看值的类型，点值直接改。
 * onChange 收到改好的 YAML 文本（不含两条 ---）。
 */
export function NoteProperties({
  yaml,
  onChange,
  readOnly,
}: {
  yaml: string;
  onChange: (yaml: string) => void;
  readOnly?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(() => globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1");
  const [adding, setAdding] = useState(false);
  const properties = parseNoteProperties(yaml);
  const save = (key: string, value: unknown) => {
    let next: string;
    try {
      next = setNoteProperty(yaml, key, value);
    } catch (error) {
      // 只会因为改完的 YAML 读不回去而失败；原文没动，告诉用户
      toast.error(`${text("saveFailed")} (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    onChange(next);
  };
  const toggle = () => {
    globalThis.localStorage?.setItem(COLLAPSED_KEY, collapsed ? "0" : "1");
    setCollapsed(!collapsed);
  };
  return (
    <section className="note-properties" aria-label={text("title")}>
      <button type="button" className="note-properties-heading" aria-expanded={!collapsed} onClick={toggle}>
        <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
        {text("title")}
      </button>
      {!collapsed &&
        (properties === null ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-destructive text-xs">{text("invalid")}</p>
            <pre className="note-properties-raw">{yaml}</pre>
          </div>
        ) : (
          <div className="flex flex-col">
            {properties.map((property) => (
              <PropertyRow
                key={property.key}
                property={property}
                readOnly={readOnly}
                onSave={(value) => save(property.key, value)}
                onRemove={() => save(property.key, undefined)}
              />
            ))}
            {!readOnly &&
              (adding ? (
                <NewProperty
                  existing={properties.map((property) => property.key)}
                  onDone={(key) => {
                    setAdding(false);
                    if (key) save(key, null);
                  }}
                />
              ) : (
                <button type="button" className="note-properties-add" onClick={() => setAdding(true)}>
                  <Plus className="size-3.5" />
                  {text("add")}
                </button>
              ))}
          </div>
        ))}
    </section>
  );
}

function PropertyRow({
  property,
  readOnly,
  onSave,
  onRemove,
}: {
  property: NoteProperty;
  readOnly?: boolean;
  onSave: (value: unknown) => void;
  onRemove: () => void;
}) {
  const Icon = KIND_ICONS[property.kind];
  return (
    <div className="note-property group">
      <div className="note-property-key" title={property.key}>
        <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="truncate">{property.key}</span>
        {!readOnly && (
          <button
            type="button"
            className="note-property-remove"
            aria-label={i18next.t("noteProperties.remove", {
              ns: "research",
              key: property.key,
              interpolation: { escapeValue: false },
            })}
            onClick={onRemove}
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
      <div className="note-property-value">
        <PropertyValue property={property} readOnly={readOnly} onSave={onSave} />
      </div>
    </div>
  );
}

function PropertyValue({
  property,
  readOnly,
  onSave,
}: {
  property: NoteProperty;
  readOnly?: boolean;
  onSave: (value: unknown) => void;
}) {
  const { kind, value } = property;
  if (kind === "list" || kind === "tags")
    return (
      <ListValue
        values={(Array.isArray(value) ? value : value == null ? [] : [value]).map(String)}
        tags={kind === "tags"}
        readOnly={readOnly}
        onSave={onSave}
      />
    );
  if (kind === "checkbox")
    return (
      <input
        type="checkbox"
        className="size-4 accent-[var(--primary)]"
        checked={value === true}
        disabled={readOnly}
        onChange={(event) => onSave(event.target.checked)}
      />
    );
  if (kind === "date")
    return (
      <input
        type="date"
        className="note-property-input w-auto"
        value={value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "")}
        disabled={readOnly}
        onChange={(event) => onSave(event.target.value || null)}
      />
    );
  if (kind === "other") return <span className="note-property-empty">{JSON.stringify(value)}</span>;
  return <ScalarValue property={property} readOnly={readOnly} onSave={onSave} />;
}

function ScalarValue({
  property,
  readOnly,
  onSave,
}: {
  property: NoteProperty;
  readOnly?: boolean;
  onSave: (value: unknown) => void;
}) {
  const original = property.value == null ? "" : String(property.value);
  const [draft, setDraft] = useState(original);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(original), [original]);
  const commit = () => {
    setEditing(false);
    if (draft === original) return;
    if (property.kind === "number" && draft.trim() && Number.isFinite(Number(draft))) onSave(Number(draft));
    else onSave(draft.trim() ? draft : null);
  };
  if (property.kind === "link" && !editing)
    return (
      <span className="flex min-w-0 items-center gap-1">
        <a
          href={original}
          className="note-property-link"
          onClick={(event) => {
            event.preventDefault();
            void shellOpen(original).catch((error) => toast.error(String(error)));
          }}
        >
          {original}
        </a>
        {!readOnly && (
          <button type="button" className="note-property-edit" onClick={() => setEditing(true)}>
            {text("edit")}
          </button>
        )}
      </span>
    );
  return (
    <textarea
      rows={1}
      value={draft}
      readOnly={readOnly}
      autoFocus={editing}
      placeholder={text("empty")}
      aria-label={property.key}
      className="note-property-input"
      style={{ fieldSizing: "content" }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(original);
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function ListValue({
  values,
  tags,
  readOnly,
  onSave,
}: {
  values: string[];
  tags: boolean;
  readOnly?: boolean;
  onSave: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const value = tags ? draft.trim().replace(/^#/, "") : draft.trim();
    setDraft("");
    if (value && !values.includes(value)) onSave([...values, value]);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {values.map((value, index) => (
        <span key={`${value}-${index}`} className={cn("note-property-chip", tags && "is-tag")}>
          {tags ? `#${value}` : value}
          {!readOnly && (
            <button
              type="button"
              aria-label={i18next.t("noteProperties.removeValue", {
                ns: "research",
                value,
                interpolation: { escapeValue: false },
              })}
              onClick={() => onSave(values.filter((_, other) => other !== index))}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          value={draft}
          placeholder={values.length ? "" : text("empty")}
          aria-label={text("addValue")}
          className="note-property-input min-w-16 flex-1"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Backspace" && !draft && values.length) onSave(values.slice(0, -1));
          }}
        />
      )}
      {readOnly && !values.length && <span className="note-property-empty">{text("empty")}</span>}
    </div>
  );
}

function NewProperty({ existing, onDone }: { existing: string[]; onDone: (key: string | null) => void }) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const finish = () => {
    const key = name.trim();
    if (key && existing.includes(key)) {
      toast.error(text("exists"));
      return;
    }
    onDone(key || null);
  };
  return (
    <div className="note-property">
      <div className="note-property-key">
        <Text className="size-3.5 shrink-0" strokeWidth={1.75} />
        <input
          ref={input}
          autoFocus
          value={name}
          placeholder={text("newName")}
          aria-label={text("newName")}
          className="note-property-input"
          onChange={(event) => setName(event.target.value)}
          onBlur={finish}
          onKeyDown={(event) => {
            if (event.key === "Enter") input.current?.blur();
            if (event.key === "Escape") onDone(null);
          }}
        />
      </div>
    </div>
  );
}

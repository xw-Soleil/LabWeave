import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import i18next from "i18next";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Plus,
  Trash2,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type TableAlign = "left" | "center" | "right" | null;

export interface ParsedTable {
  header: string[];
  align: TableAlign[];
  rows: string[][];
}

/** 单元格位置；row 为 -1 是表头 */
export interface TableCell {
  row: number;
  column: number;
}

/** 按没转义的竖线切开一行，首尾的竖线可有可无；`\|` 在格子里显示成 `|` */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && text[index + 1] === "|") {
      current += "|";
      index++;
    } else if (text[index] === "|") {
      cells.push(current.trim());
      current = "";
    } else current += text[index];
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

export function parseTable(source: string): ParsedTable | null {
  const lines = source.split("\n");
  if (lines.length < 2) return null;
  const header = splitTableRow(lines[0]);
  // 各行格数不齐时按表头补齐，多出来的不显示（和 Markdown 的规定一样）
  const fit = <T,>(cells: T[], empty: T) =>
    Array.from({ length: header.length }, (_, index) => (index < cells.length ? cells[index] : empty));
  return {
    header,
    align: fit(splitTableRow(lines[1]).map(alignOf), null),
    rows: lines.slice(2).map((line) => fit(splitTableRow(line), "")),
  };
}

const formatRow = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
const DELIMITER = { left: ":---", center: ":---:", right: "---:" } as const;
const formatDelimiter = (align: TableAlign[]) =>
  `| ${align.map((value) => (value ? DELIMITER[value] : "---")).join(" | ")} |`;

/** 改一格：只重写那一行，其他行原样不动 */
export function setTableCell(source: string, { row, column }: TableCell, text: string): string {
  const table = parseTable(source);
  if (!table) return source;
  const cells = [...(row < 0 ? table.header : table.rows[row])];
  if (cells[column] === text) return source;
  cells[column] = text;
  const lines = source.split("\n");
  lines[row < 0 ? 0 : row + 2] = formatRow(cells);
  return lines.join("\n");
}

/** 在第 at 行（表头下面从 0 数）前插入空行 */
export function insertTableRow(source: string, at: number): string {
  const table = parseTable(source);
  if (!table) return source;
  const lines = source.split("\n");
  lines.splice(at + 2, 0, formatRow(table.header.map(() => "")));
  return lines.join("\n");
}

export function deleteTableRow(source: string, row: number): string {
  const lines = source.split("\n");
  if (row < 0 || row + 2 >= lines.length) return source;
  lines.splice(row + 2, 1);
  return lines.join("\n");
}

/** 增删列要动每一行，整张表按统一格式重写 */
function rewrite(table: ParsedTable): string {
  return [formatRow(table.header), formatDelimiter(table.align), ...table.rows.map(formatRow)].join("\n");
}

export function insertTableColumn(source: string, at: number): string {
  const table = parseTable(source);
  if (!table) return source;
  const insert = <T,>(cells: T[], value: T) => [...cells.slice(0, at), value, ...cells.slice(at)];
  return rewrite({
    header: insert(table.header, ""),
    align: insert(table.align, null),
    rows: table.rows.map((cells) => insert(cells, "")),
  });
}

export function deleteTableColumn(source: string, column: number): string {
  const table = parseTable(source);
  if (!table || table.header.length <= 1) return source;
  const remove = <T,>(cells: T[]) => cells.filter((_, index) => index !== column);
  return rewrite({ header: remove(table.header), align: remove(table.align), rows: table.rows.map(remove) });
}

export function setTableAlign(source: string, column: number, align: TableAlign): string {
  const table = parseTable(source);
  if (!table || table.align[column] === align) return source;
  const lines = source.split("\n");
  lines[1] = formatDelimiter(table.align.map((value, index) => (index === column ? align : value)));
  return lines.join("\n");
}

const text = (key: string, options?: Record<string, unknown>) =>
  i18next.t(`markdownTable.${key}`, { ns: "research", ...options });

function placeCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 正在改的格子：里面的字由用户自己打，React 不碰；只有撤销这类外面的改动才把字换掉 */
function CellInput({
  value,
  label,
  onValue,
  onKeyDown,
  onBlur,
}: {
  value: string;
  label: string;
  onValue: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onBlur: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    if (element.textContent === value) return;
    element.textContent = value;
    if (document.activeElement === element) placeCaretAtEnd(element);
  }, [value]);
  useLayoutEffect(() => {
    ref.current!.focus();
    placeCaretAtEnd(ref.current!);
  }, []);
  // 格子里只能是一行，粘贴进来的换行换成空格
  const commit = () => onValue((ref.current!.textContent ?? "").replace(/\r?\n/g, " "));
  return (
    <div
      ref={ref}
      role="textbox"
      aria-label={label}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      className="cm-lp-table-cell cm-lp-table-input"
      onInput={(event) => {
        if (!(event.nativeEvent as InputEvent).isComposing) commit();
      }}
      onCompositionEnd={commit}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}

/**
 * 实时预览里的表格，照 Obsidian：点哪格改哪格，Tab / 回车跳格，到最后一格自动加一行；
 * 右键插入、删除行列和改对齐。每次改动都直接写回原文。
 */
export function TableEditor({
  source,
  edit,
  undo,
  redo,
  leave,
  renderInline,
}: {
  source: string;
  edit: (change: (source: string) => string) => void;
  undo: () => void;
  redo: () => void;
  /** 按 Esc：回到正文，光标放在表格下面 */
  leave: () => void;
  renderInline: (text: string) => ReactNode;
}) {
  const [editing, setEditing] = useState<TableCell | null>(null);
  const [menuCell, setMenuCell] = useState<TableCell | null>(null);
  const table = parseTable(source);
  if (!table) return null;
  const width = table.header.length;
  const height = table.rows.length;
  const same = (a: TableCell | null, b: TableCell) => a?.row === b.row && a.column === b.column;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, cell: TableCell) => {
    // 输入法选词时的回车、方向键归输入法
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && (key === "z" || key === "y")) {
      // 撤销走编辑器自己的历史，和正文一起撤
      event.preventDefault();
      if (key === "y" || event.shiftKey) redo();
      else undo();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const index = (cell.row + 1) * width + cell.column + (event.shiftKey ? -1 : 1);
      if (index < 0) return;
      if (index >= (height + 1) * width) {
        edit((current) => insertTableRow(current, height));
        setEditing({ row: height, column: 0 });
        return;
      }
      setEditing({ row: Math.floor(index / width) - 1, column: index % width });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !mod) {
      event.preventDefault();
      if (cell.row + 1 >= height) edit((current) => insertTableRow(current, height));
      setEditing({ row: cell.row + 1, column: cell.column });
      return;
    }
    if (event.key === "ArrowUp" && cell.row >= 0) {
      event.preventDefault();
      setEditing({ row: cell.row - 1, column: cell.column });
      return;
    }
    if (event.key === "ArrowDown" && cell.row + 1 < height) {
      event.preventDefault();
      setEditing({ row: cell.row + 1, column: cell.column });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(null);
      leave();
    }
  };

  const renderCell = (value: string, cell: TableCell) => {
    const label = text("cell", { row: cell.row + 2, column: cell.column + 1 });
    return same(editing, cell) ? (
      <CellInput
        value={value}
        label={label}
        onValue={(next) => edit((current) => setTableCell(current, cell, next))}
        onKeyDown={(event) => onKeyDown(event, cell)}
        onBlur={() => setEditing((current) => (current && same(current, cell) ? null : current))}
      />
    ) : (
      <div
        role="button"
        tabIndex={-1}
        aria-label={label}
        className="cm-lp-table-cell"
        // 松手时才进编辑：按着拖过几个格子是选字（和阅读模式一样能复制、翻译、问 AI），拖过以后不进编辑。
        // 焦点要先落在格子上：焦点还在编辑器上时，编辑器下一次更新会把表格里的选区收走（实测）
        onMouseDown={(event) => event.button === 0 && event.currentTarget.focus({ preventScroll: true })}
        onClick={(event) => {
          // 点在链接上就打开链接，不进编辑
          if ((event.target as Element).closest("a")) return;
          if (window.getSelection()?.isCollapsed === false) return;
          setEditing(cell);
        }}
      >
        {value ? renderInline(value) : " "}
      </div>
    );
  };

  const cellProps = (cell: TableCell) => ({
    style: { textAlign: table.align[cell.column] ?? undefined },
    onContextMenu: () => setMenuCell(cell),
  });

  const act = (change: (source: string, cell: TableCell) => string) => () => {
    if (menuCell) edit((current) => change(current, menuCell));
  };

  return (
    <div className="cm-lp-table">
      <ContextMenu onOpenChange={(open) => !open && setMenuCell(null)}>
        <ContextMenuTrigger asChild>
          <div className="cm-lp-table-scroll">
            <table>
              <thead>
                <tr>
                  {table.header.map((value, column) => (
                    <th key={column} {...cellProps({ row: -1, column })}>
                      {renderCell(value, { row: -1, column })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((cells, row) => (
                  <tr key={row}>
                    {cells.map((value, column) => (
                      <td key={column} {...cellProps({ row, column })}>
                        {renderCell(value, { row, column })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-40">
          <ContextMenuItem
            disabled={!menuCell || menuCell.row < 0}
            onSelect={act((current, cell) => insertTableRow(current, cell.row))}
          >
            <ArrowUpToLine />
            {text("rowAbove")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={act((current, cell) => insertTableRow(current, cell.row + 1))}>
            <ArrowDownToLine />
            {text("rowBelow")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={act((current, cell) => insertTableColumn(current, cell.column))}>
            <ArrowLeftToLine />
            {text("columnLeft")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={act((current, cell) => insertTableColumn(current, cell.column + 1))}>
            <ArrowRightToLine />
            {text("columnRight")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={act((current, cell) => setTableAlign(current, cell.column, "left"))}>
            <AlignLeft />
            {text("alignLeft")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={act((current, cell) => setTableAlign(current, cell.column, "center"))}>
            <AlignCenter />
            {text("alignCenter")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={act((current, cell) => setTableAlign(current, cell.column, "right"))}>
            <AlignRight />
            {text("alignRight")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={!menuCell || menuCell.row < 0}
            onSelect={act((current, cell) => deleteTableRow(current, cell.row))}
          >
            <Trash2 />
            {text("deleteRow")}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            disabled={width <= 1}
            onSelect={act((current, cell) => deleteTableColumn(current, cell.column))}
          >
            <Trash2 />
            {text("deleteColumn")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <button
        type="button"
        className="cm-lp-table-add cm-lp-table-add-column"
        aria-label={text("addColumn")}
        title={text("addColumn")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => edit((current) => insertTableColumn(current, width))}
      >
        <Plus />
      </button>
      <button
        type="button"
        className="cm-lp-table-add cm-lp-table-add-row"
        aria-label={text("addRow")}
        title={text("addRow")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          edit((current) => insertTableRow(current, height));
          setEditing({ row: height, column: 0 });
        }}
      >
        <Plus />
      </button>
    </div>
  );
}

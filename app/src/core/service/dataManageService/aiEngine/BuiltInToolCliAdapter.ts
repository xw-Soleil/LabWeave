import z from "zod/v4";
import {
  getBuiltInToolDefinition,
  getListedBuiltInToolCatalog,
  type BuiltInToolDefinition,
} from "./BuiltInToolRegistry";

export type BuiltInToolCliEntry = {
  name: string;
  description: string;
  inputSchema: object;
};

function toCliEntry({ name, description, inputSchema }: BuiltInToolDefinition): BuiltInToolCliEntry {
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(inputSchema),
  };
}

export function getBuiltInToolCliEntries(): BuiltInToolCliEntry[] {
  return getListedBuiltInToolCatalog().map(toCliEntry);
}

export function getBuiltInToolCliEntry(name: string): BuiltInToolCliEntry | undefined {
  const definition = getBuiltInToolDefinition(name);
  if (!definition || !getListedBuiltInToolCatalog().includes(definition)) return undefined;
  return toCliEntry(definition);
}

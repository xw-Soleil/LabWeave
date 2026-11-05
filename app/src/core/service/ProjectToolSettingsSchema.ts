import z from "zod";

export const MAC_DEFAULT_FONT_FAMILY = "PingFang SC, PingFang TC, -apple-system";
export const DEFAULT_FONT_FAMILY = "-apple-system, BlinkMacSystemFont, MiSans, system-ui, sans-serif";

export function createProjectToolSettingSchemas(defaultFontFamily: string) {
  return {
    defaultFontFamily: z.string().default(defaultFontFamily),
    defaultEdgeLineType: z.union([z.literal("solid"), z.literal("dashed"), z.literal("double")]).default("solid"),
    enableAutoEdgeWidth: z.boolean().default(true),
    defaultEdgeArrowType: z
      .union([
        z.literal("default"),
        z.literal("hollow-triangle"),
        z.literal("filled-triangle"),
        z.literal("hollow-diamond"),
        z.literal("filled-diamond"),
      ])
      .default("default"),
    historyManagerMode: z.union([z.literal("memoryEfficient"), z.literal("timeEfficient")]).default("timeEfficient"),
    historySize: z.number().int().min(1).max(5000).default(150),
    showDebug: z.boolean().default(false),
    protectingPrivacy: z.boolean().default(false),
    textIntegerLocationAndSizeRender: z.boolean().default(false),
    isEnableEntityCollision: z.boolean().default(true),
    isEnableSectionCollision: z.boolean().default(false),
    moveFriction: z.number().min(0).max(1).default(0.1),
    moveAmplitude: z.number().min(0).max(10).default(2),
    effectsPerferences: z.record(z.string(), z.boolean()).default({}),
    maxPastedImageSize: z.number().int().min(256).max(8192).default(1920),
    // 默认不填，用户配置之前不会向任何服务发请求
    aiApiBaseUrl: z.string().default(""),
    aiApiKey: z.string().default(""),
    aiModel: z.string().default(""),
    aiCustomHeaders: z.string().default(""),
    aiApiFormat: z.union([z.literal("openai"), z.literal("anthropic")]).default("openai"),
    aiPdfTextPages: z.number().int().min(0).max(50).default(3),
    researchFolderPath: z.string().default(""),
    writeAiSidecarOnSave: z.boolean().default(true),
  };
}

export function parseProjectToolSettings(rawSettings: unknown, defaultFontFamily: string): Record<string, unknown> {
  const settingSchemas = createProjectToolSettingSchemas(defaultFontFamily);
  const raw = rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings) ? rawSettings : {};
  return Object.fromEntries(
    Object.entries(settingSchemas).map(([key, schema]) => {
      const result = schema.safeParse((raw as Record<string, unknown>)[key]);
      return [key, result.success ? result.data : schema.parse(undefined)];
    }),
  );
}

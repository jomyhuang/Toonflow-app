const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
];

const models: ProviderModel[] = [
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", type: "text" },
  { id: "glm-4.7", label: "GLM-4.7", type: "text" },
  { id: "glm-5.3", label: "GLM-5.3", type: "text" },
];

export default {
  id: "zhipuCoding" as const,
  label: "智谱 GLM Coding Plan",
  icon: "",
  version: "2.0.0",
  apiUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  protocol: "openai-completions",
  readme:
    "智谱 GLM Coding Plan 专用接入，API 地址已固定为 coding 端点。\n\n注意：Coding Plan 的资源仅在此端点有效，标准端点会报「余额不足」。填写 Coding Plan 的 API Key 后即可使用 GLM-5.3 系列模型。",
  rules,
  models,
} satisfies ProviderDefinition<typeof rules>;

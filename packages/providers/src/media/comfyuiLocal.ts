// 本地 ComfyUI 接入：把「导出（API）」格式的工作流 JSON 作为模型运行，
// 向指定节点注入提示词、随机化种子，经 /prompt → /history → /view 完成生成。
const version = "2.0.0";

const rules = [
  {
    type: "input",
    field: "baseUrl" as const,
    title: "ComfyUI 服务地址",
    value: "http://127.0.0.1:8188",
    props: { placeholder: "本机默认 http://127.0.0.1:8188；Toonflow 跑在 Docker 里时改用 http://host.docker.internal:8188" },
  },
  {
    type: "input",
    field: "imageWorkflow" as const,
    title: "文生图工作流（API 格式 JSON）",
    value: "",
    props: { placeholder: "ComfyUI 界面「工作流 → 导出（API）」得到的 JSON 全文原样粘贴到这里" },
  },
  {
    type: "input",
    field: "promptNodeId" as const,
    title: "图片正向提示词节点 ID",
    value: "6",
  },
  {
    type: "input",
    field: "videoWorkflow" as const,
    title: "视频工作流（API 格式 JSON，留空则不提供视频生成）",
    value: "",
    props: { placeholder: "同样是「导出（API）」的 JSON；视频与图片各用一份工作流" },
  },
  {
    type: "input",
    field: "videoPromptNodeId" as const,
    title: "视频正向提示词节点 ID",
    value: "6",
  },
  {
    type: "input",
    field: "firstFrameNodeId" as const,
    title: "视频首帧 LoadImage 节点 ID（可选）",
    value: "",
    props: { placeholder: "图生视频工作流里承接首帧图片的 LoadImage 节点编号" },
  },
  {
    type: "input",
    field: "videoI2VWorkflow" as const,
    title: "图生视频工作流（API 格式 JSON，带首帧时优先使用）",
    value: "",
    props: { placeholder: "含首帧输入（LoadImage→H3 i2v）的工作流；留空则始终用上面的视频工作流" },
  },
  {
    type: "input",
    field: "videoI2VPromptNodeId" as const,
    title: "图生视频提示词节点 ID",
    value: "",
  },
  {
    type: "input",
    field: "promptField" as const,
    title: "图片提示词字段名",
    value: "text",
    props: { placeholder: "提示词注入到节点的哪个输入；Qwen 模板填 prompt，SD 模板填 text" },
  },
  {
    type: "input",
    field: "videoPromptField" as const,
    title: "视频提示词字段名",
    value: "prompt",
  },
  {
    type: "input",
    field: "videoI2VPromptField" as const,
    title: "图生视频提示词字段名",
    value: "prompt",
  },
];

type ComfyWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

function trimBase(value: unknown): string {
  return String(value || "http://127.0.0.1:8188").trim().replace(/\/+$/, "");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ComfyUI 响应格式错误");
  return value as Record<string, unknown>;
}

function parseWorkflow(source: unknown, kind: string): ComfyWorkflow {
  const text = String(source ?? "").trim();
  if (!text) throw new Error(`请先在供应商设置中粘贴${kind}工作流 JSON（ComfyUI「导出（API）」的文件内容）`);
  const workflow = JSON.parse(text);
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) throw new Error("工作流 JSON 结构不对，应为「节点 ID → 节点」的对象");
  return workflow as ComfyWorkflow;
}

function injectPrompt(workflow: ComfyWorkflow, nodeId: string, field: string, prompt: string) {
  const node = workflow[nodeId];
  if (!node || !node.inputs) throw new Error(`工作流里找不到提示词节点 ${nodeId}，请核对设置中的节点 ID`);
  node.inputs[field || "text"] = prompt;
}

// ACT: 每次生成随机化种子，否则同一提示词会复用工作流里固定的 seed 得到同一张图。
function randomizeSeeds(workflow: ComfyWorkflow) {
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    for (const key of ["seed", "noise_seed"]) {
      if (typeof inputs[key] === "number") inputs[key] = Math.floor(Math.random() * 2147483647);
    }
  }
}

function wait(signal: AbortSignal | undefined, milliseconds: number) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function submitWorkflow(context: ProviderContext, workflow: ComfyWorkflow) {
  const base = trimBase(context.config.baseUrl);
  const response = await context.tool.fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "toonflow" }),
    signal: context.signal,
  });
  if (!response.ok) {
    const detail = await response.text().then(text => text.slice(0, 600)).catch(() => "");
    throw new Error(`提交工作流失败（HTTP ${response.status}）：${detail || "无法连接 ComfyUI，请确认服务地址与节点输入是否正确"}`);
  }
  const queued = object(await response.json());
  const promptId = typeof queued.prompt_id === "string" ? queued.prompt_id : "";
  if (!promptId) throw new Error("ComfyUI 未返回任务 ID，请检查工作流是否能正常执行");
  return { base, promptId };
}

async function collectOutputs(context: ProviderContext, base: string, promptId: string) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await wait(context.signal, 2000);
    const response = await context.tool.fetch(`${base}/history/${promptId}`, { signal: context.signal }).catch(() => null);
    if (!response || !response.ok) continue;
    const history = object(await response.json());
    const entry = object(history[promptId] ?? {});
    const status = object(entry.status ?? {});
    if (status.status_str === "error") {
      const messages = Array.isArray(status.messages) ? JSON.stringify(status.messages.slice(-3)) : JSON.stringify(status).slice(0, 600);
      throw new Error(`ComfyUI 执行出错：${messages}`);
    }
    const outputs = object(entry.outputs ?? {});
    if (status.completed === true || Object.keys(outputs).length > 0) return outputs;
  }
  throw new Error("等待 ComfyUI 生成超时（30 分钟），可在 ComfyUI 界面查看队列状态");
}

function mediaTypeOf(fileName: string): "image" | "video" {
  return /\.(mp4|webm|mov|mkv|avi)$/i.test(fileName) ? "video" : "image";
}

function mimeOf(fileName: string): string {
  if (/\.png$/i.test(fileName)) return "image/png";
  if (/\.jpe?g$/i.test(fileName)) return "image/jpeg";
  if (/\.webp$/i.test(fileName)) return "image/webp";
  if (/\.gif$/i.test(fileName)) return "image/gif";
  if (/\.mp4$/i.test(fileName)) return "video/mp4";
  if (/\.webm$/i.test(fileName)) return "video/webm";
  return "application/octet-stream";
}

function outputFiles(outputs: Record<string, unknown>): Array<{ filename: string; subfolder?: string; type?: string }> {
  const files: Array<{ filename: string; subfolder?: string; type?: string }> = [];
  for (const nodeOutput of Object.values(outputs)) {
    const record = nodeOutput as Record<string, unknown>;
    for (const key of ["images", "gifs", "videos"]) {
      const list = record[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const file = item as Record<string, unknown>;
        if (typeof file.filename === "string" && file.filename) {
          files.push({ filename: file.filename, subfolder: typeof file.subfolder === "string" ? file.subfolder : "", type: typeof file.type === "string" ? file.type : "output" });
        }
      }
    }
  }
  return files;
}

async function fetchAsset(context: ProviderContext, base: string, file: { filename: string; subfolder?: string; type?: string }) {
  const query = `filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder ?? "")}&type=${encodeURIComponent(file.type ?? "output")}`;
  const response = await context.tool.fetch(`${base}/view?${query}`, { signal: context.signal });
  if (!response.ok) throw new Error(`取回生成结果失败（HTTP ${response.status}）：${file.filename}`);
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return { mediaType: mediaTypeOf(file.filename), type: "base64" as const, mimeType: mimeOf(file.filename), data };
}

async function toBytes(context: ProviderContext, input: MediaInput): Promise<Uint8Array> {
  if (input.type === "binary") return input.data;
  if (input.type === "base64") return new Uint8Array(Buffer.from(input.data.replace(/^data:[^;,]+;base64,/, ""), "base64"));
  const response = await context.tool.fetch(input.url, { signal: context.signal });
  if (!response.ok) throw new Error(`下载参考图失败（HTTP ${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
}

// ACT: ComfyUI /upload/image 只收 multipart；沙箱里没有 FormData，手动拼一个。
async function uploadImage(context: ProviderContext, base: string, input: MediaInput) {
  const bytes = await toBytes(context, input);
  const extension = input.mimeType?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  const fileName = `toonflow_${Date.now()}.${extension}`;
  const boundary = `----toonflow${Date.now().toString(16)}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: ${input.mimeType || "image/png"}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const response = await context.tool.fetch(`${base}/upload/image`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`上传首帧图片失败（HTTP ${response.status}）`);
  const uploaded = object(await response.json());
  if (typeof uploaded.name !== "string") throw new Error("ComfyUI 未返回上传图片文件名");
  return typeof uploaded.subfolder === "string" && uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

async function runWorkflow(context: ProviderContext, workflow: ComfyWorkflow) {
  const { base, promptId } = await submitWorkflow(context, workflow);
  return { base, outputs: await collectOutputs(context, base, promptId) };
}

export default {
  id: "comfyuiLocal" as const,
  label: "ComfyUI 本地",
  version,
  readme:
    "把本机 ComfyUI 的工作流变成 Toonflow 模型。\n\n使用步骤：\n1. 在 ComfyUI 里摆好能正常出图/出视频的工作流；\n2. 「工作流 → 导出（API）」得到 JSON，全文粘贴到对应设置项；\n3. 填写正向提示词所在的节点 ID（默认模板是 6）；\n4. 视频如需首帧，再填首帧 LoadImage 节点 ID。\n\n生成时会自动随机化工作流里的 seed；分辨率、时长等仍由工作流本身决定。",
  rules,
  models: [
    { id: "comfyui-image", label: "ComfyUI 本地文生图", type: "image", mode: ["text"] },
    { id: "comfyui-video", label: "ComfyUI 本地视频", type: "video", mode: ["text", "startFrameOptional"] },
  ],

  async generateImage(this: ProviderContext, request: ImageRequest) {
    const workflow = parseWorkflow(this.config.imageWorkflow, "文生图");
    injectPrompt(workflow, String(this.config.promptNodeId || "6"), String(this.config.promptField || "text"), request.prompt);
    randomizeSeeds(workflow);
    const { base, outputs } = await runWorkflow(this, workflow);
    const files = outputFiles(outputs).filter(file => mediaTypeOf(file.filename) === "image");
    if (!files.length) throw new Error("ComfyUI 未返回图片，请确认工作流的保存节点勾选了输出");
    return Promise.all(files.map(file => fetchAsset(this, base, file)));
  },

  async generateVideo(this: ProviderContext, request: VideoRequest) {
    const useI2V = !!request.firstFrame && String(this.config.videoI2VWorkflow || "").trim().length > 0;
    const kind = useI2V ? "图生视频" : "视频";
    const workflow = parseWorkflow(useI2V ? this.config.videoI2VWorkflow : this.config.videoWorkflow, kind);
    const promptNodeId = String((useI2V ? this.config.videoI2VPromptNodeId : this.config.videoPromptNodeId) || "6");
    const promptField = String((useI2V ? this.config.videoI2VPromptField : this.config.videoPromptField) || "text");
    injectPrompt(workflow, promptNodeId, promptField, request.prompt);
    const firstFrameNodeId = String(this.config.firstFrameNodeId || "").trim();
    if (request.firstFrame) {
      if (!useI2V) throw new Error("本次带了首帧图片，但未配置图生视频工作流（设置中的「图生视频工作流」为空）");
      if (!firstFrameNodeId) throw new Error("本次带了首帧图片，但设置里没填「视频首帧 LoadImage 节点 ID」");
      const node = workflow[firstFrameNodeId];
      if (!node || !node.inputs) throw new Error(`工作流里找不到首帧节点 ${firstFrameNodeId}`);
      node.inputs.image = await uploadImage(this, trimBase(this.config.baseUrl), request.firstFrame);
    }
    randomizeSeeds(workflow);
    const { base, outputs } = await runWorkflow(this, workflow);
    const files = outputFiles(outputs).filter(file => mediaTypeOf(file.filename) === "video" || /\.gif$/i.test(file.filename));
    if (!files.length) throw new Error("ComfyUI 未返回视频，请确认工作流的视频保存节点（如 Video Combine）已启用输出");
    return Promise.all(files.map(file => fetchAsset(this, base, file)));
  },
} satisfies ProviderDefinition<typeof rules>;

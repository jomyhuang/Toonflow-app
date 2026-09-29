/// <reference path="./types.d.ts" />

import tfRouterLanguage from "./src/language/tfRouter";
import deepSeek from "./src/language/deepSeek";
import zhipuCodingLanguage from "./src/language/zhipuCoding";
import tfRouterMedia from "./src/media/tfRouter";
import comfyuiLocalMedia from "./src/media/comfyuiLocal";

export type Provider = ProviderDefinition;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [tfRouterLanguage, deepSeek, zhipuCodingLanguage] as const;
export const mediaProviders = [tfRouterMedia, comfyuiLocalMedia] as const;

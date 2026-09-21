/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { URL } from 'url';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { GitHubDeviceFlowAuth } from '../auth/githubDeviceFlowAuth';

export interface ChatMessageParam {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, any>;
	};
}

export interface ToolCallResult {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ChatCompletionResponse {
	content: string;
	toolCalls?: ToolCallResult[];
}

export interface CopilotModelInfo {
	id: string;
	name: string;
	vendor?: string;
	version?: string;
	isDefault?: boolean;
}

export const FALLBACK_COPILOT_MODELS: CopilotModelInfo[] = [
	{ id: 'gpt-4o', name: 'GPT-4o', vendor: 'OpenAI / Azure', isDefault: true },
	{ id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', vendor: 'Anthropic' },
	{ id: 'o1-mini', name: 'o1-mini', vendor: 'OpenAI / Azure' },
	{ id: 'gpt-4o-mini', name: 'GPT-4o mini', vendor: 'OpenAI / Azure' }
];

export const EDIT_SKETCH_FILE_TOOL: ToolDefinition = {
	type: 'function',
	function: {
		name: 'edit_sketch_file',
		description: 'Directly modify, fix, or update an Arduino sketch file (.ino, .cpp, .h) in the active project. Call this tool whenever the user asks to fix compiler errors, modify code logic, adjust settings/baud rates, or add microcontroller features.',
		parameters: {
			type: 'object',
			properties: {
				filename: {
					type: 'string',
					description: 'The sketch filename to edit (e.g. spacemouse-2025.ino, config.h).'
				},
				explanation: {
					type: 'string',
					description: 'A brief, user-friendly explanation of what changes were made.'
				},
				updatedContent: {
					type: 'string',
					description: 'The entire updated source code for the file.'
				}
			},
			required: ['filename', 'explanation', 'updatedContent']
		}
	}
};

export const SET_ACTIVE_BOARD_TOOL: ToolDefinition = {
	type: 'function',
	function: {
		name: 'set_active_board',
		description: 'Change or set the target microcontroller board for the sketch (e.g. Arduino Uno, ESP32, Uno R4 WiFi, Raspberry Pi Pico, Arduino Nano). Use this whenever the user asks to switch board, change target hardware, or compile for a different microcontroller.',
		parameters: {
			type: 'object',
			properties: {
				board: {
					type: 'string',
					description: 'Target board name or FQBN (e.g. "esp32", "uno r4", "arduino:avr:uno", "nano", "pico").'
				}
			},
			required: ['board']
		}
	}
};

export interface CopilotTokenData {
	token: string;
	endpoints?: {
		api?: string;
		[key: string]: string | undefined;
	};
	expires_at: number;
}

export interface ICopilotApiService {
	readonly _serviceBrand: undefined;
	getCopilotToken(forceRefresh?: boolean): Promise<{ token: string; apiEndpoint: string }>;
	getAvailableModels(forceRefresh?: boolean): Promise<CopilotModelInfo[]>;
	getSelectedModel(): string;
	setSelectedModel(modelId: string): void;
	getApiBaseUrl(tokenApiEndpoint?: string): string;
	streamChat(
		messages: ChatMessageParam[],
		onChunk: (chunk: string) => void,
		model?: string
	): Promise<string>;
	streamChatWithTools(
		messages: ChatMessageParam[],
		onChunk: (chunk: string) => void,
		tools?: ToolDefinition[],
		model?: string
	): Promise<ChatCompletionResponse>;
}

export const ICopilotApiService = createServiceIdentifier<ICopilotApiService>('ICopilotApiService');

export class CopilotApiService extends Disposable implements ICopilotApiService {
	declare _serviceBrand: undefined;

	private _cachedTokenData: CopilotTokenData | undefined;
	private _cachedModels: { models: CopilotModelInfo[]; timestamp: number } | undefined;
	private _selectedModel: string = 'gpt-4o';

	constructor() {
		super();
	}

	/**
	 * Resolve effective Copilot API Base URL honoring user settings, environment variables,
	 * and ephemeral token endpoints (e.g. api.business.githubcopilot.com).
	 */
	public getApiBaseUrl(tokenApiEndpoint?: string): string {
		// 1. User configuration setting
		try {
			const config = vscode.workspace.getConfiguration('arduino.copilot');
			const configuredUrl = config.get<string>('apiBaseUrl');
			if (configuredUrl && configuredUrl.trim().length > 0) {
				return configuredUrl.trim().replace(/\/+$/, '');
			}
		} catch {}

		// 2. Environment variable overrides (e.g. COPILOT_API_URL or GITHUB_COPILOT_BASE_URL)
		const envUrl = process.env.COPILOT_API_URL || process.env.GITHUB_COPILOT_BASE_URL;
		if (envUrl && envUrl.trim().length > 0) {
			return envUrl.trim().replace(/\/+$/, '');
		}

		// 3. Token endpoints API from GitHub internal auth
		if (tokenApiEndpoint && tokenApiEndpoint.trim().length > 0) {
			return tokenApiEndpoint.trim().replace(/\/+$/, '');
		}

		// 4. Default standard endpoint
		return 'https://api.individual.githubcopilot.com';
	}

	public getSelectedModel(): string {
		try {
			const config = vscode.workspace.getConfiguration('arduino.copilot');
			const model = config.get<string>('model');
			if (model && model.trim().length > 0) {
				return model.trim();
			}
		} catch {}
		return this._selectedModel || 'gpt-4o';
	}

	public setSelectedModel(modelId: string): void {
		this._selectedModel = modelId;
		try {
			const config = vscode.workspace.getConfiguration('arduino.copilot');
			config.update('model', modelId, vscode.ConfigurationTarget.Global);
		} catch {}
	}

	/**
	 * Dynamically discover models available from the Copilot API endpoint (/models).
	 * Falls back gracefully to standard supported models if unavailable or offline.
	 */
	public async getAvailableModels(forceRefresh = false): Promise<CopilotModelInfo[]> {
		const now = Date.now();
		if (!forceRefresh && this._cachedModels && (now - this._cachedModels.timestamp < 10 * 60 * 1000)) {
			return this._cachedModels.models;
		}

		try {
			const tokenInfo = await this.getCopilotToken();
			const url = new URL('/models', tokenInfo.apiEndpoint);

			const models = await new Promise<CopilotModelInfo[]>((resolve, reject) => {
				const req = https.get(url.href, {
					headers: {
						'Authorization': `Bearer ${tokenInfo.token}`,
						'User-Agent': 'GitHubCopilotChat/0.44.0',
						'Editor-Version': 'vscode/1.95.0',
						'Editor-Plugin-Version': 'copilot-chat/0.44.0',
						'Accept': 'application/json'
					}
				}, (res) => {
					let body = '';
					res.on('data', c => body += c);
					res.on('end', () => {
						if (res.statusCode !== 200) {
							return reject(new Error(`Models endpoint returned HTTP ${res.statusCode}`));
						}
						try {
							const parsed = JSON.parse(body);
							const list = Array.isArray(parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
							const result: CopilotModelInfo[] = [];

							for (const item of list) {
								if (item.id) {
									result.push({
										id: item.id,
										name: item.name || item.id,
										vendor: item.vendor || (item.id.includes('claude') ? 'Anthropic' : 'OpenAI'),
										version: item.version,
										isDefault: item.id === 'gpt-4o'
									});
								}
							}

							if (result.length > 0) {
								resolve(result);
							} else {
								resolve(FALLBACK_COPILOT_MODELS);
							}
						} catch (err: any) {
							reject(err);
						}
					});
				});

				req.on('error', reject);
			});

			this._cachedModels = { models, timestamp: now };
			return models;
		} catch (err) {
			console.warn('[CopilotApiService] Could not fetch models from Copilot API, using standard fallback models:', err);
			return FALLBACK_COPILOT_MODELS;
		}
	}

	/**
	 * Retrieve a valid, ephemeral GitHub Copilot API token.
	 * Exchanges the user's stored OAuth token from ~/.config/github-copilot/apps.json
	 * or current VS Code authentication session.
	 */
	public async getCopilotToken(forceRefresh = false): Promise<{ token: string; apiEndpoint: string }> {
		const nowSec = Math.floor(Date.now() / 1000);

		if (!forceRefresh && this._cachedTokenData && nowSec < this._cachedTokenData.expires_at - 120) {
			const apiEndpoint = this.getApiBaseUrl(this._cachedTokenData.endpoints?.api);
			return { token: this._cachedTokenData.token, apiEndpoint };
		}

		// 1. Obtain GitHub OAuth token
		const auth = GitHubDeviceFlowAuth.getInstance();
		const session = auth.getCurrentSession();
		let oauthToken = session?.accessToken;

		if (!oauthToken) {
			const saved = auth.readSavedToken();
			oauthToken = saved?.token;
		}

		if (!oauthToken) {
			throw new Error('Not authenticated with GitHub Copilot. Please click the "Sign In" button in the Arduino Copilot banner.');
		}

		// 2. Exchange OAuth token for Copilot API token
		const tokenData = await this.fetchCopilotInternalToken(oauthToken);
		this._cachedTokenData = tokenData;

		const apiEndpoint = this.getApiBaseUrl(tokenData.endpoints?.api);
		return { token: tokenData.token, apiEndpoint };
	}

	/**
	 * Stream chat completions from the official Copilot chat API.
	 */
	public async streamChat(
		messages: ChatMessageParam[],
		onChunk: (chunk: string) => void,
		model?: string
	): Promise<string> {
		const effectiveModel = model || this.getSelectedModel();
		const res = await this.streamChatWithTools(messages, onChunk, undefined, effectiveModel);
		return res.content;
	}

	/**
	 * Stream chat completions with OpenAI-compatible tool definitions (e.g. edit_sketch_file).
	 */
	public async streamChatWithTools(
		messages: ChatMessageParam[],
		onChunk: (chunk: string) => void,
		tools?: ToolDefinition[],
		model?: string
	): Promise<ChatCompletionResponse> {
		const effectiveModel = model || this.getSelectedModel();
		let tokenInfo = await this.getCopilotToken();

		try {
			return await this.executeStreamChat(tokenInfo, messages, onChunk, tools, effectiveModel);
		} catch (error: any) {
			// If 401 Unauthorized, refresh token and retry once
			if (error?.message && error.message.includes('401')) {
				console.warn('[CopilotApiService] Token expired or rejected (401). Refreshing token and retrying...');
				tokenInfo = await this.getCopilotToken(true);
				return await this.executeStreamChat(tokenInfo, messages, onChunk, tools, effectiveModel);
			}
		}
	}

	private executeStreamChat(
		tokenInfo: { token: string; apiEndpoint: string },
		messages: ChatMessageParam[],
		onChunk: (chunk: string) => void,
		tools: ToolDefinition[] | undefined,
		model: string
	): Promise<ChatCompletionResponse> {
		const url = new URL('/chat/completions', tokenInfo.apiEndpoint);
		const requestBody: any = {
			model,
			stream: true,
			messages
		};

		if (tools && tools.length > 0) {
			requestBody.tools = tools;
		}

		const payload = JSON.stringify(requestBody);

		return new Promise((resolve, reject) => {
			const req = https.request({
				hostname: url.hostname,
				port: 443,
				path: url.pathname,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${tokenInfo.token}`,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload),
					'User-Agent': 'GitHubCopilotChat/0.44.0',
					'Editor-Version': 'vscode/1.95.0',
					'Editor-Plugin-Version': 'copilot-chat/0.44.0',
					'Openai-Organization': 'github-copilot',
					'Openai-Intent': 'conversation-panel'
				}
			}, (res) => {
				if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
					let errBody = '';
					res.on('data', c => errBody += c);
					res.on('end', () => {
						reject(new Error(`Copilot API responded with HTTP ${res.statusCode}: ${errBody}`));
					});
					return;
				}

				let buffer = '';
				let fullText = '';
				const accumulatedToolCalls: Map<number, ToolCallResult> = new Map();

				const handleParsedChunk = (parsed: any) => {
					const choice = parsed.choices?.[0];
					if (!choice) return;

					// 1. Text delta
					const deltaContent = choice.delta?.content;
					if (deltaContent) {
						fullText += deltaContent;
						onChunk(deltaContent);
					}

					// 2. Tool calls delta
					const toolCalls = choice.delta?.tool_calls;
					if (Array.isArray(toolCalls)) {
						for (const tc of toolCalls) {
							const idx = tc.index ?? 0;
							if (!accumulatedToolCalls.has(idx)) {
								accumulatedToolCalls.set(idx, {
									id: tc.id || '',
									type: 'function',
									function: {
										name: tc.function?.name || '',
										arguments: tc.function?.arguments || ''
									}
								});
							} else {
								const existing = accumulatedToolCalls.get(idx)!;
								if (tc.id) existing.id += tc.id;
								if (tc.function?.name) existing.function.name += tc.function.name;
								if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
							}
						}
					}
				};

				res.on('data', (chunk: Buffer) => {
					buffer += chunk.toString('utf8');
					const lines = buffer.split('\n');
					// Keep the incomplete trailing line in the buffer
					buffer = lines.pop() || '';

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith('data:')) {
							continue;
						}

						const dataStr = trimmed.slice(5).trim();
						if (dataStr === '[DONE]') {
							const toolCalls = Array.from(accumulatedToolCalls.values());
							resolve({
								content: fullText,
								toolCalls: toolCalls.length > 0 ? toolCalls : undefined
							});
							return;
						}

						try {
							const parsed = JSON.parse(dataStr);
							handleParsedChunk(parsed);
						} catch {
							// Incomplete JSON or malformed chunk; ignore and proceed
						}
					}
				});

				res.on('end', () => {
					// Flush any remaining data line
					if (buffer.trim().startsWith('data:')) {
						const dataStr = buffer.trim().slice(5).trim();
						if (dataStr && dataStr !== '[DONE]') {
							try {
								const parsed = JSON.parse(dataStr);
								handleParsedChunk(parsed);
							} catch {}
						}
					}
					const toolCalls = Array.from(accumulatedToolCalls.values());
					resolve({
						content: fullText,
						toolCalls: toolCalls.length > 0 ? toolCalls : undefined
					});
				});
			});

			req.on('error', (err) => {
				reject(new Error(`Failed to send request to Copilot API: ${err.message}`));
			});

			req.write(payload);
			req.end();
		});
	}

	private fetchCopilotInternalToken(oauthToken: string): Promise<CopilotTokenData> {
		return new Promise((resolve, reject) => {
			let tokenUrl = 'https://api.github.com/copilot_internal/v2/token';
			try {
				const config = vscode.workspace.getConfiguration('arduino.copilot');
				const enterpriseHost = config.get<string>('enterpriseUrl');
				if (enterpriseHost && enterpriseHost.trim().length > 0) {
					tokenUrl = `${enterpriseHost.trim().replace(/\/+$/, '')}/api/v3/copilot_internal/v2/token`;
				}
			} catch {}

			const parsedUrl = new URL(tokenUrl);
			const req = https.get({
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || 443,
				path: parsedUrl.pathname,
				headers: {
					'Authorization': `token ${oauthToken}`,
					'User-Agent': 'GitHubCopilotChat/0.44.0',
					'Accept': 'application/json'
				}
			}, (res) => {
				let body = '';
				res.on('data', c => body += c);
				res.on('end', () => {
					if (res.statusCode !== 200) {
						return reject(new Error(`Failed to exchange token with GitHub (HTTP ${res.statusCode}): ${body}`));
					}
					try {
						const json = JSON.parse(body) as CopilotTokenData;
						resolve(json);
					} catch (e: any) {
						reject(new Error(`Malformed response from GitHub token endpoint: ${e.message}`));
					}
				});
			});

			req.on('error', (err) => {
				reject(new Error(`Network error connecting to GitHub: ${err.message}`));
			});
		});
	}
}

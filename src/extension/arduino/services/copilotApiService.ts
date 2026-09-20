/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

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

	constructor() {
		super();
	}

	/**
	 * Retrieve a valid, ephemeral GitHub Copilot API token.
	 * Exchanges the user's stored OAuth token from ~/.config/github-copilot/apps.json
	 * or current VS Code authentication session.
	 */
	public async getCopilotToken(forceRefresh = false): Promise<{ token: string; apiEndpoint: string }> {
		const nowSec = Math.floor(Date.now() / 1000);

		if (!forceRefresh && this._cachedTokenData && nowSec < this._cachedTokenData.expires_at - 120) {
			const apiEndpoint = this._cachedTokenData.endpoints?.api || 'https://api.individual.githubcopilot.com';
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

		const apiEndpoint = tokenData.endpoints?.api || 'https://api.individual.githubcopilot.com';
		return { token: tokenData.token, apiEndpoint };
	}

	/**
	 * Stream chat completions from the official Copilot chat API (e.g. gpt-4o).
	 */
	public async streamChat(
		messages: ChatMessageParam[],
		onChunk: (chunk: string) => void,
		model = 'gpt-4o'
	): Promise<string> {
		const res = await this.streamChatWithTools(messages, onChunk, undefined, model);
		return res.content;
	}

	/**
	 * Stream chat completions with OpenAI-compatible tool definitions (e.g. edit_sketch_file).
	 */
	public async streamChatWithTools(
		messages: ChatMessageParam[],
		onChunk: (chunk: string) => void,
		tools?: ToolDefinition[],
		model = 'gpt-4o'
	): Promise<ChatCompletionResponse> {
		let tokenInfo = await this.getCopilotToken();

		try {
			return await this.executeStreamChat(tokenInfo, messages, onChunk, tools, model);
		} catch (error: any) {
			// If 401 Unauthorized, refresh token and retry once
			if (error?.message && error.message.includes('401')) {
				console.warn('[CopilotApiService] Token expired or rejected (401). Refreshing token and retrying...');
				tokenInfo = await this.getCopilotToken(true);
				return await this.executeStreamChat(tokenInfo, messages, onChunk, tools, model);
			}
			throw error;
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
			const req = https.get('https://api.github.com/copilot_internal/v2/token', {
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IArduinoCliService } from '../services/arduinoCliService';
import { IBoardContextService } from '../services/boardContextService';
import { ISketchService } from '../services/sketchService';
import { ISerialTelemetryService } from '../services/serialTelemetryService';
import { ICopilotApiService, CopilotApiService, ChatMessageParam, EDIT_SKETCH_FILE_TOOL, SET_ACTIVE_BOARD_TOOL } from '../services/copilotApiService';
import { ISkillsService, SkillsService } from '../services/skillsService';
import { ArduinoToolsRegistry } from '../tools';

export interface FileEditNotification {
	messageId: string;
	filename: string;
	previousContent: string;
	explanation: string;
}

export interface ChatMessage {
	id: string;
	sender: 'user' | 'assistant' | 'system';
	text: string;
	timestamp: number;
	toolCalls?: Array<{
		name: string;
		status: 'running' | 'done' | 'error';
		result?: string;
	}>;
}

export class CopilotCliAgentBridge extends Disposable {
	private readonly _toolsRegistry: ArduinoToolsRegistry;
	private readonly _onDidReceiveChunk = this._register(new Emitter<{ messageId: string; chunk: string }>());
	public readonly onDidReceiveChunk: Event<{ messageId: string; chunk: string }> = this._onDidReceiveChunk.event;

	private readonly _onDidUpdateToolStatus = this._register(new Emitter<{ messageId: string; toolName: string; status: 'running' | 'done' | 'error'; result?: string }>());
	public readonly onDidUpdateToolStatus: Event<{ messageId: string; toolName: string; status: 'running' | 'done' | 'error'; result?: string }> = this._onDidUpdateToolStatus.event;

	private readonly _onDidEditFile = this._register(new Emitter<FileEditNotification>());
	public readonly onDidEditFile: Event<FileEditNotification> = this._onDidEditFile.event;

	private readonly _conversationHistory: ChatMessage[] = [];

	constructor(
		private readonly arduinoCliService: IArduinoCliService,
		private readonly boardContextService: IBoardContextService,
		private readonly sketchService: ISketchService,
		private readonly serialTelemetryService: ISerialTelemetryService,
		private readonly copilotApiService: ICopilotApiService = new CopilotApiService(),
		private readonly skillsService: ISkillsService = new SkillsService(sketchService)
	) {
		super();
		this._toolsRegistry = new ArduinoToolsRegistry(
			arduinoCliService,
			boardContextService,
			sketchService,
			serialTelemetryService
		);
	}

	public getHistory(): ChatMessage[] {
		return [...this._conversationHistory];
	}

	public getToolsRegistry(): ArduinoToolsRegistry {
		return this._toolsRegistry;
	}

	/**
	 * Assemble Arduino domain system instructions
	 */
	public async buildSystemPrompt(): Promise<string> {
		const board = this.boardContextService.getActiveBoard();
		const sketchFolder = this.sketchService.getActiveSketchFolder();
		const tabs = await this.sketchService.getSketchTabs();

		let prompt = `You are Arduino Copilot, an expert AI assistant embedded in Arduino IDE.\n` +
			`You assist developers with physical computing, microcontrollers, embedded C++, circuit wiring, and debugging.\n\n` +
			`### Active Target Hardware:\n` +
			`- Board: ${board.name} (FQBN: \`${board.fqbn}\`)\n` +
			`- Architecture: ${board.architecture} (${board.clockSpeedMhz} MHz)\n` +
			`- Logic Level: ${board.voltage}V\n` +
			`- Available Memory: Flash: ${(board.flashBytes / 1024).toFixed(1)} KB, SRAM: ${(board.sramBytes / 1024).toFixed(1)} KB\n` +
			`- PWM Pins: ${board.pwmPins.join(', ')}\n` +
			`- Analog Input Pins: ${board.analogInputPins.join(', ')}\n` +
			`- I2C: SDA=${board.i2cPins.sda}, SCL=${board.i2cPins.scl}\n` +
			`- SPI: MOSI=${board.spiPins.mosi}, MISO=${board.spiPins.miso}, SCK=${board.spiPins.sck}\n\n`;

		if (board.notes && board.notes.length > 0) {
			prompt += `### Board Hardware Constraints:\n${board.notes.map(n => `- ${n}`).join('\n')}\n\n`;
		}

		prompt += `### Current Sketch Context:\n` +
			`- Folder: ${sketchFolder || 'None'}\n` +
			`- Tabs: ${tabs.map(t => t.name).join(', ') || 'No open tabs'}\n\n`;

		if (tabs.length > 0) {
			prompt += `### Active Sketch Source Code:\n`;
			for (const tab of tabs) {
				prompt += `\`\`\`cpp title="${tab.name}"\n${tab.content}\n\`\`\`\n\n`;
			}
		}

		prompt += `### Guidelines:\n` +
			`1. Write idiomatic, memory-efficient Arduino C++.\n` +
			`2. For AVR boards (e.g. Uno, Nano, Mega), preserve SRAM by using the F() macro: Serial.print(F("text")).\n` +
			`3. Avoid blocking delay() calls in loops; use non-blocking millis() timing whenever responsive behavior is needed.\n` +
			`4. Always observe board logic levels (e.g. 3.3V vs 5V) and warn if external components require level shifters or pull-ups.\n` +
			`5. You have access to Arduino tools (arduino_compile, arduino_fix_compile_errors, arduino_upload, arduino_library_manager, arduino_pinout_checker, arduino_crash_decoder, arduino_circuit_diagram).\n\n`;

		const skillsPrompt = await this.skillsService.buildSkillsPrompt();
		if (skillsPrompt) {
			prompt += `${skillsPrompt}\n`;
		}

		return prompt;
	}

	public getSkillsService(): ISkillsService {
		return this.skillsService;
	}

	public getCopilotApiService(): ICopilotApiService {
		return this.copilotApiService;
	}

	/**
	 * Process a user prompt, trigger tools as needed, and stream the response
	 */
	public async sendMessage(prompt: string, replyMessageId: string): Promise<string> {
		const userMsg: ChatMessage = {
			id: 'user_' + Date.now(),
			sender: 'user',
			text: prompt,
			timestamp: Date.now()
		};
		this._conversationHistory.push(userMsg);

		// Check for direct tool trigger phrases from UI chips or intents
		const lower = prompt.toLowerCase().trim();

		if (lower.startsWith('verify') || lower.startsWith('compile') || lower === 'verify & compile') {
			return await this.handleCompileCommand(replyMessageId);
		} else if (lower.startsWith('fix error') || lower.startsWith('fix compile') || lower === 'fix errors') {
			return await this.handleFixErrorsCommand(replyMessageId);
		} else if (lower.startsWith('upload') || lower === 'upload sketch') {
			return await this.handleUploadCommand(replyMessageId);
		} else if (lower.startsWith('check pinout') || lower.startsWith('pinout') || lower.startsWith('pin ')) {
			return await this.handlePinoutCommand(prompt, replyMessageId);
		} else if (lower.startsWith('wire') || lower.startsWith('circuit') || lower.startsWith('connect ')) {
			return await this.handleCircuitCommand(prompt, replyMessageId);
		} else if (lower.startsWith('set board') || lower.startsWith('switch board') || lower.startsWith('board:') || lower.startsWith('use board') || lower.startsWith('change board')) {
			return await this.handleSetBoardCommand(prompt, replyMessageId);
		} else if (lower === '/skills' || lower === 'skills' || lower === '/skill') {
			return await this.handleListSkillsCommand(replyMessageId);
		}

		// Standard Conversational Flow using @github/copilot/sdk if available or domain generator
		return await this.handleGeneralConversation(prompt, replyMessageId);
	}

	private async handleCompileCommand(messageId: string): Promise<string> {
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_compile', status: 'running' });
		this.streamChunk(messageId, '⏳ Compiling sketch with `arduino-cli`...\n\n');

		const result = await this._toolsRegistry.compileTool.execute({});
		this._onDidUpdateToolStatus.fire({
			messageId,
			toolName: 'arduino_compile',
			status: result.success ? 'done' : 'error',
			result: result.summary
		});

		let response = '';
		if (result.success) {
			response = `✅ **Compilation Succeeded**\n\n` +
				`- **Board**: ${this.boardContextService.getActiveBoard().name}\n` +
				(result.flashUsage ? `- **Flash (Program Storage)**: ${result.flashUsage}\n` : '') +
				(result.ramUsage ? `- **RAM (Dynamic Memory)**: ${result.ramUsage}\n` : '') +
				`\nYour sketch is ready to be uploaded to the board.`;
		} else {
			response = `❌ **Compilation Failed**\n\n` +
				`The compiler reported the following errors:\n\`\`\`\n` +
				(result.errors ? result.errors.join('\n') : result.rawOutput) +
				`\n\`\`\`\n\nClick **Fix Errors** below to let Copilot diagnose and fix this code automatically.`;
		}

		this.streamChunk(messageId, response);
		this.recordAssistantMessage(messageId, response);
		return response;
	}

	private async handleFixErrorsCommand(messageId: string): Promise<string> {
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_fix_compile_errors', status: 'running' });
		this.streamChunk(messageId, '🔍 Analyzing compiler diagnostics and sketch source tabs...\n\n');

		const result = await this._toolsRegistry.fixErrorsTool.execute({});
		this._onDidUpdateToolStatus.fire({
			messageId,
			toolName: 'arduino_fix_compile_errors',
			status: 'done',
			result: `${result.diagnostics.length} issues found`
		});

		if (!result.hasErrors) {
			const response = `✅ No compiler errors found in the current sketch! Everything builds cleanly.`;
			this.streamChunk(messageId, response);
			this.recordAssistantMessage(messageId, response);
			return response;
		}

		let response = `### 🛠️ Compiler Diagnosis\n\n${result.analysis}\n\n`;
		this.streamChunk(messageId, response);

		// Now invoke Copilot with EDIT_SKETCH_FILE_TOOL to fix the code directly!
		this.streamChunk(messageId, `⚡ **Copilot is generating and applying a direct fix...**\n\n`);

		try {
			const systemPrompt = await this.buildSystemPrompt();
			const prompt = `The sketch failed to compile with the following diagnostics:\n\`\`\`\n` +
				(result.diagnostics.map(d => `${d.file}:${d.line}: ${d.severity}: ${d.message}`).join('\n') || result.rawOutput) +
				`\n\`\`\`\n\nPlease fix the source code directly using the edit_sketch_file tool. Supply the corrected complete content for the affected sketch file and a concise explanation.`;

			const messages: ChatMessageParam[] = [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: prompt }
			];

			let editApplied = false;
			const activeModel = this.copilotApiService.getSelectedModel();
			const compRes = await this.copilotApiService.streamChatWithTools(
				messages,
				chunk => this.streamChunk(messageId, chunk),
				[EDIT_SKETCH_FILE_TOOL],
				activeModel
			);

			if (compRes.toolCalls && compRes.toolCalls.length > 0) {
				for (const tc of compRes.toolCalls) {
					if (tc.function.name === 'edit_sketch_file') {
						try {
							const args = JSON.parse(tc.function.arguments);
							this._onDidUpdateToolStatus.fire({
								messageId,
								toolName: 'arduino_edit_sketch',
								status: 'running',
								result: `Editing ${args.filename}...`
							});

							const editResult = await this.sketchService.applyFileEdit(args.filename, args.updatedContent);
							if (editResult.success) {
								editApplied = true;
								this._onDidUpdateToolStatus.fire({
									messageId,
									toolName: 'arduino_edit_sketch',
									status: 'done',
									result: `Applied: ${args.explanation}`
								});

								this._onDidEditFile.fire({
									messageId,
									filename: editResult.filename,
									previousContent: editResult.originalContent,
									explanation: args.explanation
								});

								const editMsg = `\n\n✓ **Direct fix applied to \`${editResult.filename}\`**: ${args.explanation}\n`;
								this.streamChunk(messageId, editMsg);
								response += editMsg;
							} else {
								this._onDidUpdateToolStatus.fire({
									messageId,
									toolName: 'arduino_edit_sketch',
									status: 'error',
									result: editResult.error
								});
							}
						} catch (e: any) {
							console.error('[CopilotCliAgentBridge] Failed to execute tool call:', e);
						}
					}
				}
			}

			// Automatically re-verify with compiler!
			if (editApplied) {
				this.streamChunk(messageId, '\n🔄 **Re-verifying fix with `arduino-cli compile`...**\n\n');
				const recompile = await this._toolsRegistry.compileTool.execute({});
				if (recompile.success) {
					const successMsg = `🎉 **Fix Verified! Sketch now compiles successfully.**\n` +
						(recompile.flashUsage ? `- **Flash**: ${recompile.flashUsage}\n` : '') +
						(recompile.ramUsage ? `- **RAM**: ${recompile.ramUsage}\n` : '');
					this.streamChunk(messageId, successMsg);
					response += '\n' + successMsg;
				} else {
					const failMsg = `⚠️ **Compiler still reported issues after edit**:\n\`\`\`\n` +
						(recompile.errors ? recompile.errors.join('\n') : recompile.rawOutput) +
						`\n\`\`\``;
					this.streamChunk(messageId, failMsg);
					response += '\n' + failMsg;
				}
			}

			this.recordAssistantMessage(messageId, response);
			return response;
		} catch (err: any) {
			console.error('[CopilotCliAgentBridge] Error in automatic error fix:', err);
			const fallbackMsg = `\n\n⚠️ Could not automatically apply fix via Copilot: ${err.message || err}`;
			this.streamChunk(messageId, fallbackMsg);
			response += fallbackMsg;
			this.recordAssistantMessage(messageId, response);
			return response;
		}
	}

	private async handleUploadCommand(messageId: string): Promise<string> {
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_upload', status: 'running' });
		this.streamChunk(messageId, '⚡ Uploading sketch to connected microcontroller...\n\n');

		const result = await this._toolsRegistry.uploadTool.execute({});
		this._onDidUpdateToolStatus.fire({
			messageId,
			toolName: 'arduino_upload',
			status: result.success ? 'done' : 'error',
			result: result.summary
		});

		let response = '';
		if (result.success) {
			response = `🚀 **Upload Successful!**\n\n${result.summary}\nThe sketch is now running on your board.`;
		} else {
			response = `⚠️ **Upload Failed**\n\n${result.summary}\n\n`;
			if (result.troubleshootingTips && result.troubleshootingTips.length > 0) {
				response += `**Troubleshooting Tips**:\n` + result.troubleshootingTips.map(t => `- ${t}`).join('\n') + `\n`;
			}
		}

		this.streamChunk(messageId, response);
		this.recordAssistantMessage(messageId, response);
		return response;
	}

	private async handlePinoutCommand(prompt: string, messageId: string): Promise<string> {
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_pinout_checker', status: 'running' });

		// Check if a specific pin is queried (e.g. "Can I use pin 4 for PWM?")
		const pinMatch = prompt.match(/pin\s*([0-9]+|A[0-9]+)/i);
		const pin = pinMatch ? pinMatch[1] : undefined;
		let cap: 'pwm' | 'analog' | 'interrupt' | 'i2c' | 'spi' | undefined;

		if (/pwm/i.test(prompt)) cap = 'pwm';
		else if (/analog/i.test(prompt)) cap = 'analog';
		else if (/interrupt/i.test(prompt)) cap = 'interrupt';
		else if (/i2c/i.test(prompt)) cap = 'i2c';
		else if (/spi/i.test(prompt)) cap = 'spi';

		const res = await this._toolsRegistry.pinoutTool.execute({ checkPin: pin, capability: cap });
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_pinout_checker', status: 'done' });

		const response = `### 📌 Hardware Pinout & Specs\n\n${res.summary}`;
		this.streamChunk(messageId, response);
		this.recordAssistantMessage(messageId, response);
		return response;
	}

	private async handleCircuitCommand(prompt: string, messageId: string): Promise<string> {
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_circuit_diagram', status: 'running' });

		const res = await this._toolsRegistry.circuitDiagramTool.execute({ componentName: prompt });
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_circuit_diagram', status: 'done' });

		let response = `### 🔌 Wiring & Circuit Guide: ${res.component}\n\n`;
		response += `| Component Pin | Connect To | Notes |\n| :--- | :--- | :--- |\n`;
		for (const w of res.wiringTable) {
			response += `| **${w.componentPin}** | \`${w.targetPin}\` | ${w.description} |\n`;
		}

		if (res.asciiDiagram) {
			response += `\n**Schematic Diagram**:\n\`\`\`\n${res.asciiDiagram}\n\`\`\`\n`;
		}

		if (res.safetyNotes.length > 0) {
			response += `\n**Safety & Electrical Notes**:\n` + res.safetyNotes.map(n => `- ⚠️ ${n}`).join('\n') + `\n`;
		}

		this.streamChunk(messageId, response);
		this.recordAssistantMessage(messageId, response);
		return response;
	}

	private async handleSetBoardCommand(prompt: string, messageId: string): Promise<string> {
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_set_board', status: 'running' });

		// Extract target board query
		const match = prompt.match(/(?:set|switch|change|use)?\s*(?:target\s*)?board(?:\s*to|\s*:)?\s*(.+)/i) ||
			prompt.match(/board:\s*(.+)/i);
		const query = match ? match[1].trim() : prompt.trim();

		let resolvedFqbn = this.boardContextService.resolveFqbn(query);

		if (!resolvedFqbn) {
			try {
				const installed = await this.arduinoCliService.listAllInstalledBoards();
				const lowerQ = query.toLowerCase();
				const found = installed.find(b =>
					b.fqbn.toLowerCase() === lowerQ ||
					b.name.toLowerCase() === lowerQ ||
					b.name.toLowerCase().includes(lowerQ)
				);
				if (found) {
					resolvedFqbn = found.fqbn;
				}
			} catch {}
		}

		if (resolvedFqbn) {
			this.boardContextService.setActiveBoard(resolvedFqbn);
			const board = this.boardContextService.getActiveBoard();
			this._onDidUpdateToolStatus.fire({
				messageId,
				toolName: 'arduino_set_board',
				status: 'done',
				result: `Board set to ${board.name}`
			});

			const response = `✅ **Target Board Updated to ${board.name}**\n\n` +
				`- **FQBN**: \`${board.fqbn}\`\n` +
				`- **Architecture**: ${board.architecture} (${board.clockSpeedMhz} MHz)\n` +
				`- **Operating Voltage**: ${board.voltage}V\n` +
				`- **Available Memory**: Flash: ${(board.flashBytes / 1024).toFixed(1)} KB, SRAM: ${(board.sramBytes / 1024).toFixed(1)} KB\n` +
				`- **PWM Pins**: ${board.pwmPins.join(', ')}\n` +
				`- **Analog Input Pins**: ${board.analogInputPins.join(', ')}\n` +
				(board.notes && board.notes.length > 0 ? `\n**Hardware Notes**:\n${board.notes.map(n => `- ${n}`).join('\n')}\n` : '') +
				`\nCopilot context and compilation have been synchronized with your hardware.`;

			this.streamChunk(messageId, response);
			this.recordAssistantMessage(messageId, response);
			return response;
		}

		this._onDidUpdateToolStatus.fire({
			messageId,
			toolName: 'arduino_set_board',
			status: 'error',
			result: `Unknown board "${query}"`
		});

		const response = `⚠️ Could not find a matching board for "${query}".\n\n` +
			`You can specify an FQBN directly (e.g. \`arduino:avr:uno\`, \`esp32:esp32:esp32\`, \`arduino:renesas_uno:unor4wifi\`, \`rp2040:rp2040:rp2040\`) or click the board chip in the header to select from detected or installed boards.`;

		this.streamChunk(messageId, response);
		this.recordAssistantMessage(messageId, response);
		return response;
	}

	private async handleListSkillsCommand(messageId: string): Promise<string> {
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_skills', status: 'running' });

		const skills = await this.skillsService.getSkills();
		this._onDidUpdateToolStatus.fire({ messageId, toolName: 'arduino_skills', status: 'done', result: `${skills.filter(s => s.enabled).length} active` });

		let response = `### 🧠 Arduino Agent Skills\n\n` +
			`Copilot has the following embedded development skills configured:\n\n` +
			`| Skill | Type | Status | Description |\n` +
			`| :--- | :--- | :--- | :--- |\n`;

		for (const s of skills) {
			const type = s.isBuiltIn ? 'Built-in' : 'User';
			const status = s.enabled ? '✅ Enabled' : '⚪ Disabled';
			response += `| **${s.name}** | ${type} | ${status} | ${s.description} |\n`;
		}

		response += `\n*Tip: Click the **🧠 Skills** button in the chat header to toggle skills or create your own custom skill template in \`.skills/\`.*`;

		this.streamChunk(messageId, response);
		this.recordAssistantMessage(messageId, response);
		return response;
	}

	private async handleGeneralConversation(prompt: string, messageId: string): Promise<string> {
		try {
			const systemPrompt = await this.buildSystemPrompt();
			const messages: ChatMessageParam[] = [
				{ role: 'system', content: systemPrompt }
			];

			// Include recent history for multi-turn conversational context (up to last 10 messages)
			for (const msg of this._conversationHistory.slice(-10)) {
				if (msg.sender === 'user' || msg.sender === 'assistant') {
					messages.push({
						role: msg.sender,
						content: msg.text
					});
				}
			}

			// Add the current user prompt
			messages.push({ role: 'user', content: prompt });

			let fullResponse = '';
			const activeModel = this.copilotApiService.getSelectedModel();
			const compRes = await this.copilotApiService.streamChatWithTools(
				messages,
				(chunk) => {
					fullResponse += chunk;
					this.streamChunk(messageId, chunk);
				},
				[EDIT_SKETCH_FILE_TOOL, SET_ACTIVE_BOARD_TOOL],
				activeModel
			);

			if (compRes.toolCalls && compRes.toolCalls.length > 0) {
				for (const tc of compRes.toolCalls) {
					if (tc.function.name === 'edit_sketch_file') {
						try {
							const args = JSON.parse(tc.function.arguments);
							this._onDidUpdateToolStatus.fire({
								messageId,
								toolName: 'arduino_edit_sketch',
								status: 'running',
								result: `Editing ${args.filename}...`
							});

							const editResult = await this.sketchService.applyFileEdit(args.filename, args.updatedContent);
							if (editResult.success) {
								this._onDidUpdateToolStatus.fire({
									messageId,
									toolName: 'arduino_edit_sketch',
									status: 'done',
									result: `Applied: ${args.explanation}`
								});

								this._onDidEditFile.fire({
									messageId,
									filename: editResult.filename,
									previousContent: editResult.originalContent,
									explanation: args.explanation
								});

								const editNotice = `\n\n✓ **Applied changes to \`${editResult.filename}\`**: ${args.explanation}\n`;
								if (!fullResponse.includes(args.explanation)) {
									fullResponse += editNotice;
									this.streamChunk(messageId, editNotice);
								}
							} else {
								this._onDidUpdateToolStatus.fire({
									messageId,
									toolName: 'arduino_edit_sketch',
									status: 'error',
									result: editResult.error
								});
							}
						} catch (e) {
							console.error('[CopilotCliAgentBridge] Failed to process tool call in general conversation:', e);
						}
					} else if (tc.function.name === 'set_active_board') {
						try {
							const args = JSON.parse(tc.function.arguments);
							const target = args.board;
							const resolved = this.boardContextService.resolveFqbn(target) || target;
							this.boardContextService.setActiveBoard(resolved);
							const board = this.boardContextService.getActiveBoard();
							this._onDidUpdateToolStatus.fire({
								messageId,
								toolName: 'arduino_set_board',
								status: 'done',
								result: `Board set to ${board.name}`
							});

							const setNotice = `\n\n✓ **Switched active target board to ${board.name}** (\`${board.fqbn}\`)\n`;
							fullResponse += setNotice;
							this.streamChunk(messageId, setNotice);
						} catch (e) {
							console.error('[CopilotCliAgentBridge] Failed to execute set_active_board tool:', e);
						}
					}
				}
			}

			this.recordAssistantMessage(messageId, fullResponse);
			return fullResponse;
		} catch (error: any) {
			console.error('[CopilotCliAgentBridge] Error in general conversation:', error);
			let response = `⚠️ **Could not connect to GitHub Copilot**: ${error?.message || error}\n\n`;
			response += `Please verify that you are signed in to GitHub (click the account button in the header) and that your account has an active GitHub Copilot subscription.\n\n`;
			response += `In the meantime, you can use quick action buttons below (like **⚡ Verify & Compile** or **📌 Check Pinout**) which run locally on your system without requiring cloud API access.`;

			this.streamChunk(messageId, response);
			this.recordAssistantMessage(messageId, response);
			return response;
		}
	}

	private streamChunk(messageId: string, chunk: string): void {
		this._onDidReceiveChunk.fire({ messageId, chunk });
	}

	private recordAssistantMessage(messageId: string, text: string): void {
		this._conversationHistory.push({
			id: messageId,
			sender: 'assistant',
			text,
			timestamp: Date.now()
		});
	}
}

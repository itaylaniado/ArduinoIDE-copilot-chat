/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Polyfill/shim missing VS Code proposed APIs and enums when running inside
 * Eclipse Theia / Arduino IDE 2.x to avoid activation crashes.
 */
export function applyTheiaVsCodeShim(vscodeObj?: any): void {
	try {
		const vscode = vscodeObj || (typeof require === 'function' ? require('vscode') : null);
		if (!vscode) {
			return;
		}

		if (!vscode.ChatEditingSessionActionOutcome) {
			vscode.ChatEditingSessionActionOutcome = {
				Accepted: 1,
				Rejected: 2,
				Saved: 3
			};
		}

		if (!vscode.ChatResultFeedbackKind) {
			vscode.ChatResultFeedbackKind = {
				Unhelpful: 0,
				Helpful: 1
			};
		}

		if (!vscode.InlineCompletionEndOfLifeReasonKind) {
			vscode.InlineCompletionEndOfLifeReasonKind = {
				Accepted: 0,
				Rejected: 1,
				Ignored: 2
			};
		}

		if (!vscode.RelatedInformationType) {
			vscode.RelatedInformationType = {
				CommandInformation: 1,
				SettingInformation: 2
			};
		}

		if (!vscode.ChatLocation) {
			vscode.ChatLocation = {
				Panel: 1,
				Terminal: 2,
				Editor: 3,
				Notebook: 4
			};
		}

		if (!vscode.ChatSessionStatus) {
			vscode.ChatSessionStatus = {
				InProgress: 1,
				Completed: 2,
				Failed: 3
			};
		}

		if (!vscode.ChatVariableLevel) {
			vscode.ChatVariableLevel = {
				Short: 1,
				Medium: 2,
				Full: 3
			};
		}

		if (!vscode.ChatDebugLogLevel) {
			vscode.ChatDebugLogLevel = {
				Trace: 1,
				Debug: 2,
				Info: 3,
				Warning: 4,
				Error: 5
			};
		}

		if (!vscode.ChatDebugToolCallResult) {
			vscode.ChatDebugToolCallResult = {
				Success: 1,
				Error: 2
			};
		}

		if (!vscode.ChatDebugSubagentStatus) {
			vscode.ChatDebugSubagentStatus = {
				Running: 1,
				Completed: 2,
				Failed: 3
			};
		}

		if (!vscode.ChatDebugHookResult) {
			vscode.ChatDebugHookResult = {
				Success: 1,
				Error: 2,
				NonBlockingError: 3
			};
		}

		if (!vscode.ChatSessionCustomizationType) {
			vscode.ChatSessionCustomizationType = {
				Agent: 1,
				Skill: 2,
				Instructions: 3,
				Hook: 4,
				Plugins: 5
			};
		}

		if (!vscode.InlineCompletionDisplayLocationKind) {
			vscode.InlineCompletionDisplayLocationKind = {
				Code: 1,
				Label: 2
			};
		}

		if (!vscode.InlineCompletionsDisposeReasonKind) {
			vscode.InlineCompletionsDisposeReasonKind = {
				NotTaken: 0,
				LostRace: 1,
				TokenCancellation: 2
			};
		}

		if (!vscode.LanguageModelChatMessageRole) {
			vscode.LanguageModelChatMessageRole = {
				User: 1,
				Assistant: 2,
				System: 3
			};
		}

		if (!vscode.LanguageModelChatToolMode) {
			vscode.LanguageModelChatToolMode = {
				Auto: 1,
				Required: 2
			};
		}

		if (!vscode.SettingsSearchResultKind) {
			vscode.SettingsSearchResultKind = {
				EXACT_MATCH: 1,
				SYNONYM: 2,
				EMBEDDED: 3,
				LLM_RANKED: 4
			};
		}

		function patchProperty(parent: any, prop: string, stubs: any): void {
			if (!parent) return;
			const current = parent[prop];
			if (!current) {
				const target = Object.assign({}, stubs);
				try {
					parent[prop] = target;
				} catch {
					Object.defineProperty(parent, prop, {
						value: target,
						writable: true,
						configurable: true,
						enumerable: true
					});
				}
				return;
			}

			const overrides: Record<string, any> = Object.assign({}, stubs);

			const proxy = new Proxy({}, {
				get(_target: any, p: string | symbol, receiver: any) {
					if (typeof p === 'string' && p in overrides) {
						return overrides[p];
					}
					const val = Reflect.get(current, p);
					return typeof val === 'function' ? val.bind(current) : val;
				},
				set(_target: any, p: string | symbol, value: any) {
					if (typeof p === 'string') {
						overrides[p] = value;
					}
					return true;
				},
				has(_target: any, p: string | symbol) {
					return (typeof p === 'string' && p in overrides) || p in current;
				}
			});

			try {
				parent[prop] = proxy;
			} catch {
				Object.defineProperty(parent, prop, {
					value: proxy,
					writable: true,
					configurable: true,
					enumerable: true
				});
			}
		}

		patchProperty(vscode, 'chat', {
			createChatParticipant: (_id: string, _handler: any) => ({
				onDidReceiveFeedback: () => ({ dispose: () => {} }),
				onDidPerformAction: () => ({ dispose: () => {} }),
				dispose: () => {},
				iconPath: undefined,
				supportIssueReporting: false
			}),
			registerChatSessionItemProvider: () => ({ dispose: () => {} }),
			registerChatSessionContentProvider: () => ({ dispose: () => {} }),
			registerChatSessionCustomizationProvider: () => ({ dispose: () => {} }),
			registerChatParticipantDetectionProvider: () => ({ dispose: () => {} }),
			registerCustomAgentProvider: () => ({ dispose: () => {} }),
			registerInstructionsProvider: () => ({ dispose: () => {} }),
			registerMappedEditsProvider2: () => ({ dispose: () => {} }),
			registerChatDebugLogProvider: () => ({ dispose: () => {} }),
			createChatSessionItemController: () => ({ dispose: () => {} }),
			onDidChangeCustomAgents: () => ({ dispose: () => {} }),
			onDidChangeInstructions: () => ({ dispose: () => {} }),
			onDidChangeSkills: () => ({ dispose: () => {} }),
			onDidChangeHooks: () => ({ dispose: () => {} }),
			onDidChangePlugins: () => ({ dispose: () => {} }),
			customAgents: [],
			instructions: [],
			skills: [],
			hooks: [],
			plugins: []
		});

		if (!vscode.ai) {
			vscode.ai = {
				registerRelatedInformationProvider: () => ({ dispose: () => {} }),
				registerSettingsSearchProvider: () => ({ dispose: () => {} })
			};
		}

		const lmStubs: Record<string, any> = {
			selectChatModels: async () => [],
			registerLanguageModelChatProvider: () => ({ dispose: () => {} }),
			registerTool: () => ({ dispose: () => {} }),
			invokeTool: async () => ({ content: [] }),
			tools: [],
			onDidChangeTools: () => ({ dispose: () => {} }),
			mcpServerDefinitions: [],
			onDidChangeMcpServerDefinitions: () => ({ dispose: () => {} }),
			startMcpGateway: async () => undefined
		};
		const lmProxy = new Proxy(lmStubs, {
			get(target: any, p: string | symbol) {
				if (typeof p === 'string') {
					if (p in target) {
						return target[p];
					}
					if (p.startsWith('register') || p.startsWith('onDidChange')) {
						return () => ({ dispose: () => {} });
					}
				}
				return target[p];
			}
		});

		patchProperty(vscode, 'lm', lmProxy);

		const powerStubs: Record<string, any> = {
			onDidSuspend: () => ({ dispose: () => {} }),
			onDidResume: () => ({ dispose: () => {} }),
			onDidChangeOnBatteryPower: () => ({ dispose: () => {} }),
			onDidChangeThermalState: () => ({ dispose: () => {} }),
			onDidChangeSpeedLimit: () => ({ dispose: () => {} }),
			onWillShutdown: () => ({ dispose: () => {} }),
			onDidLockScreen: () => ({ dispose: () => {} }),
			onDidUnlockScreen: () => ({ dispose: () => {} }),
			isOnBatteryPower: async () => false,
			getCurrentThermalState: async () => 'nominal',
			getSystemIdleTime: async () => 0,
			startPowerSaveBlocker: async () => ({ id: 1, dispose: () => {} })
		};
		const powerProxy = new Proxy(powerStubs, {
			get(target: any, p: string | symbol) {
				if (typeof p === 'string') {
					if (p in target) {
						return target[p];
					}
					if (p.startsWith('onDid') || p.startsWith('onWill')) {
						return () => ({ dispose: () => {} });
					}
				}
				return target[p];
			}
		});

		patchProperty(vscode, 'env', {
			createTelemetryLogger: (sender?: any, options?: any) => ({
				onDidChangeEnableStates: () => ({ dispose: () => {} }),
				isUsageEnabled: true,
				isErrorsEnabled: true,
				logUsage: (eventName: string, data?: any) => {
					try { sender?.sendEventData?.(eventName, data); } catch {}
				},
				logError: (errorOrEventName: any, data?: any) => {
					try {
						if (typeof errorOrEventName === 'string') {
							sender?.sendEventData?.(errorOrEventName, data);
						} else {
							sender?.sendErrorData?.(errorOrEventName, data);
						}
					} catch {}
				},
				dispose: () => {}
			}),
			getDataChannel: (channelName: string) => ({
				channelName,
				onDidReceiveData: () => ({ dispose: () => {} }),
				postMessage: () => {},
				dispose: () => {}
			}),
			power: powerProxy
		});

		if (!vscode.l10n) {
			vscode.l10n = {
				t: (msg: any, ...args: any[]) => {
					if (typeof msg === 'string') {
						let str = msg;
						for (let i = 0; i < args.length; i++) {
							str = str.replace(`{${i}}`, String(args[i]));
						}
						return str;
					}
					return (msg && msg.message) || String(msg || '');
				},
				uri: undefined,
				bundle: undefined
			};
		}

		patchProperty(vscode, 'authentication', {
			getSession: async () => undefined,
			registerAuthenticationProvider: () => ({ dispose: () => {} }),
			onDidChangeSessions: () => ({ dispose: () => {} })
		});

		try {
			const { GitHubDeviceFlowAuth } = require('../../../extension/arduino/auth/githubDeviceFlowAuth');
			GitHubDeviceFlowAuth.getInstance().installShim();
		} catch (e) {
			// Ignore if not resolvable during early bundling
		}

		patchProperty(vscode, 'debug', {
			registerDebugAdapterTrackerFactory: () => ({ dispose: () => {} }),
			onDidStartDebugSession: () => ({ dispose: () => {} }),
			onDidTerminateDebugSession: () => ({ dispose: () => {} }),
			activeDebugSession: undefined
		});

		patchProperty(vscode, 'window', {
			onDidExecuteTerminalCommand: () => ({ dispose: () => {} }),
			onDidChangeTerminalState: () => ({ dispose: () => {} }),
			onDidWriteTerminalData: () => ({ dispose: () => {} }),
			onDidCloseTerminal: () => ({ dispose: () => {} }),
			createChatStatusItem: (id: string) => ({
				id,
				title: '',
				description: '',
				detail: undefined,
				show: () => {},
				hide: () => {},
				dispose: () => {}
			}),
			tabGroups: {
				all: [],
				activeTabGroup: undefined,
				onDidChangeTabGroups: () => ({ dispose: () => {} }),
				onDidChangeTabs: () => ({ dispose: () => {} }),
				close: async () => true
			}
		});

		patchProperty(vscode, 'workspace', {
			isTrusted: true,
			requestWorkspaceTrust: async () => true,
			onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
			isAgentSessionsWorkspace: false,
			registerAITextSearchProvider: () => ({ dispose: () => {} })
		});

		patchProperty(vscode, 'extensions', {
			getExtension: () => undefined,
			all: [],
			onDidChange: () => ({ dispose: () => {} })
		});

		if (!vscode.ExtensionMode) {
			vscode.ExtensionMode = { Production: 1, Development: 2, Test: 3 };
		}
		if (!vscode.ExtensionKind) {
			vscode.ExtensionKind = { UI: 1, Workspace: 2 };
		}

		if (!vscode.DiagnosticSeverity) {
			vscode.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
		}
		if (!vscode.EndOfLine) {
			vscode.EndOfLine = { LF: 1, CRLF: 2 };
		}
		if (!vscode.FileType) {
			vscode.FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
		}
		if (!vscode.NotebookCellKind) {
			vscode.NotebookCellKind = { Markup: 1, Code: 2 };
		}
		if (!vscode.TextEditorSelectionChangeKind) {
			vscode.TextEditorSelectionChangeKind = { Keyboard: 1, Mouse: 2, Command: 3 };
		}
		if (!vscode.TextDocumentChangeReason) {
			vscode.TextDocumentChangeReason = { Undo: 1, Redo: 2 };
		}
		if (!vscode.SymbolKind) {
			vscode.SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25 };
		}
		if (!vscode.CodeAction) {
			vscode.CodeAction = class {
				title: string;
				kind: any;
				constructor(title: string, kind?: any) {
					this.title = title;
					this.kind = kind;
				}
			};
		}
		if (!vscode.CodeActionKind || typeof vscode.CodeActionKind.QuickFix?.append !== 'function') {
			class CodeActionKindImpl {
				readonly value: string;
				constructor(value: string) {
					this.value = value;
				}
				append(parts: string): CodeActionKindImpl {
					return new CodeActionKindImpl(this.value ? `${this.value}.${parts}` : parts);
				}
				contains(other: any): boolean {
					return other && (this.value === other.value || (other.value && other.value.startsWith(this.value + '.')));
				}
				intersects(other: any): boolean {
					return this.contains(other) || (other && typeof other.contains === 'function' && other.contains(this));
				}
			}
			(CodeActionKindImpl as any).Empty = new CodeActionKindImpl('');
			(CodeActionKindImpl as any).QuickFix = new CodeActionKindImpl('quickfix');
			(CodeActionKindImpl as any).Refactor = new CodeActionKindImpl('refactor');
			(CodeActionKindImpl as any).RefactorExtract = new CodeActionKindImpl('refactor.extract');
			(CodeActionKindImpl as any).RefactorInline = new CodeActionKindImpl('refactor.inline');
			(CodeActionKindImpl as any).RefactorRewrite = new CodeActionKindImpl('refactor.rewrite');
			(CodeActionKindImpl as any).Source = new CodeActionKindImpl('source');
			(CodeActionKindImpl as any).SourceOrganizeImports = new CodeActionKindImpl('source.organizeImports');
			(CodeActionKindImpl as any).SourceFixAll = new CodeActionKindImpl('source.fixAll');
			vscode.CodeActionKind = CodeActionKindImpl as any;
		}
		if (!vscode.TreeItem) {
			vscode.TreeItem = class {
				label: any;
				collapsibleState: any;
				constructor(label: any, collapsibleState?: any) {
					this.label = label;
					this.collapsibleState = collapsibleState;
				}
			};
		}
		if (!vscode.TreeItemCollapsibleState) {
			vscode.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
		}
		if (!vscode.ThemeIcon) {
			const ThemeIconClass = class {
				id: string;
				color?: any;
				constructor(id: string, color?: any) {
					this.id = id;
					this.color = color;
				}
			};
			(ThemeIconClass as any).File = new ThemeIconClass('file');
			(ThemeIconClass as any).Folder = new ThemeIconClass('folder');
			vscode.ThemeIcon = ThemeIconClass as any;
		}
		if (!vscode.ThemeColor) {
			vscode.ThemeColor = class {
				id: string;
				constructor(id: string) {
					this.id = id;
				}
			} as any;
		}
		if (!vscode.InlineCompletionList) {
			vscode.InlineCompletionList = class {
				items: any[];
				commands?: any[];
				constructor(items?: any[]) {
					this.items = items || [];
				}
			} as any;
		}
		if (!vscode.InlineCompletionItem) {
			vscode.InlineCompletionItem = class {
				insertText: any;
				range?: any;
				command?: any;
				constructor(insertText: any, range?: any, command?: any) {
					this.insertText = insertText;
					this.range = range;
					this.command = command;
				}
			} as any;
		}
		if (!vscode.InlineCompletionTriggerKind) {
			vscode.InlineCompletionTriggerKind = { Invoke: 0, Automatic: 1 };
		}
		if (!vscode.ConfigurationTarget) {
			vscode.ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
		}
		if (!vscode.ColorThemeKind) {
			vscode.ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
		}
		if (!vscode.ProgressLocation) {
			vscode.ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
		}
		if (!vscode.QuickPickItemKind) {
			vscode.QuickPickItemKind = { Separator: -1, Default: 0 };
		}
		if (!vscode.StatusBarAlignment) {
			vscode.StatusBarAlignment = { Left: 1, Right: 2 };
		}
		if (!vscode.LogLevel) {
			vscode.LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 };
		}
		if (!vscode.CommentMode) {
			vscode.CommentMode = { Editing: 0, Preview: 1 };
		}
		if (!vscode.CommentThreadCollapsibleState) {
			vscode.CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };
		}
		if (!vscode.TextEditorRevealType) {
			vscode.TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
		}
		if (!vscode.TextEditorCursorStyle) {
			vscode.TextEditorCursorStyle = { Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 };
		}
		if (!vscode.TextEditorLineNumbersStyle) {
			vscode.TextEditorLineNumbersStyle = { Off: 0, On: 1, Relative: 2 };
		}
		if (!vscode.LanguageModelChatMessage) {
			vscode.LanguageModelChatMessage = {
				User: (content: any, name?: string) => ({ role: 1, content, name }),
				Assistant: (content: any, name?: string) => ({ role: 2, content, name }),
				System: (content: any) => ({ role: 3, content })
			} as any;
		}
		if (!vscode.LanguageModelError) {
			vscode.LanguageModelError = {
				Blocked: (msg: string) => new Error(msg),
				NotFound: (msg: string) => new Error(msg)
			} as any;
		}
		if (!vscode.LanguageModelTextPart) {
			vscode.LanguageModelTextPart = class {
				constructor(public value: string) {}
			} as any;
		}
		if (!vscode.LanguageModelToolCallPart) {
			vscode.LanguageModelToolCallPart = class {
				constructor(public callId: string, public name: string, public input: any) {}
			} as any;
		}
		if (!vscode.LanguageModelToolResultPart) {
			vscode.LanguageModelToolResultPart = class {
				constructor(public callId: string, public content: any[]) {}
			} as any;
		}
	} catch {
		// Ignore any error in non-standard environments
	}
}

// Auto-apply immediately when module is imported
applyTheiaVsCodeShim();

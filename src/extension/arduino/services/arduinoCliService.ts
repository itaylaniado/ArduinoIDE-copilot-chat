/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

export interface CompileResult {
	success: boolean;
	compilerOutput: string;
	errorOutput?: string;
	builderResult?: {
		buildPath?: string;
		usedRam?: number;
		totalRam?: number;
		usedFlash?: number;
		totalFlash?: number;
		executableSectionsSize?: Array<{ name: string; size: number; maxSize: number }>;
	};
}

export interface UploadResult {
	success: boolean;
	output: string;
	error?: string;
}

export interface ArduinoBoardPort {
	address: string;
	label: string;
	protocol: string;
	protocolLabel: string;
	properties?: Record<string, string>;
}

export interface ArduinoDetectedBoard {
	name: string;
	fqbn: string;
	port: ArduinoBoardPort;
}

export interface LibrarySearchResult {
	name: string;
	author: string;
	maintainer: string;
	sentence: string;
	paragraph?: string;
	website?: string;
	category?: string;
	version: string;
	installed?: string;
}

export interface CoreSearchResult {
	id: string;
	installed?: string;
	latest: string;
	name: string;
	maintainer: string;
}

export interface IArduinoCliService {
	readonly _serviceBrand: undefined;
	findCliPath(): Promise<string | undefined>;
	compile(sketchPath: string, fqbn: string): Promise<CompileResult>;
	upload(sketchPath: string, fqbn: string, port: string): Promise<UploadResult>;
	listDetectedBoards(): Promise<ArduinoDetectedBoard[]>;
	getBoardDetails(fqbn: string): Promise<any | undefined>;
	listAllInstalledBoards(): Promise<Array<{ name: string; fqbn: string }>>;
	searchLibraries(query: string): Promise<LibrarySearchResult[]>;
	installLibrary(libName: string): Promise<{ success: boolean; message: string }>;
	searchCores(query: string): Promise<CoreSearchResult[]>;
	installCore(coreName: string): Promise<{ success: boolean; message: string }>;
}

export const IArduinoCliService = createServiceIdentifier<IArduinoCliService>('IArduinoCliService');

export class ArduinoCliService extends Disposable implements IArduinoCliService {
	declare _serviceBrand: undefined;
	private _cachedCliPath: string | undefined;

	constructor() {
		super();
	}

	public async findCliPath(): Promise<string | undefined> {
		if (this._cachedCliPath && fs.existsSync(this._cachedCliPath)) {
			return this._cachedCliPath;
		}

		// 1. Check user configuration setting
		const configuredPath = vscode.workspace.getConfiguration('arduino.copilot').get<string>('cliPath');
		if (configuredPath && fs.existsSync(configuredPath)) {
			this._cachedCliPath = configuredPath;
			return configuredPath;
		}

		// 2. Candidate platform paths for Arduino IDE 2.x
		const candidates: string[] = [];
		const platform = os.platform();

		if (platform === 'darwin') {
			candidates.push(
				'/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli',
				path.join(os.homedir(), 'Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli'),
				'/usr/local/bin/arduino-cli',
				'/opt/homebrew/bin/arduino-cli'
			);
		} else if (platform === 'win32') {
			const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
			const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
			candidates.push(
				path.join(localAppData, 'Programs', 'Arduino IDE', 'resources', 'app', 'lib', 'backend', 'resources', 'arduino-cli.exe'),
				path.join(programFiles, 'Arduino IDE', 'resources', 'app', 'lib', 'backend', 'resources', 'arduino-cli.exe'),
				'C:\\Program Files (x86)\\Arduino IDE\\resources\\app\\lib\\backend\\resources\\arduino-cli.exe'
			);
		} else {
			// Linux
			candidates.push(
				'/opt/arduino-ide/resources/app/lib/backend/resources/arduino-cli',
				'/usr/local/bin/arduino-cli',
				'/usr/bin/arduino-cli',
				path.join(os.homedir(), '.local/bin/arduino-cli')
			);
		}

		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				this._cachedCliPath = candidate;
				return candidate;
			}
		}

		// 3. Fallback: check if 'arduino-cli' is available on PATH
		try {
			const whichCmd = platform === 'win32' ? 'where' : 'which';
			const res = cp.execSync(`${whichCmd} arduino-cli`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
			if (res) {
				const firstLine = res.split(/\r?\n/)[0];
				if (fs.existsSync(firstLine)) {
					this._cachedCliPath = firstLine;
					return firstLine;
				}
			}
		} catch {
			// Not on PATH
		}

		return undefined;
	}

	private async execCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
		const cli = await this.findCliPath();
		if (!cli) {
			throw new Error('arduino-cli executable could not be found. Please configure "arduino.copilot.cliPath" or ensure Arduino IDE 2.x is installed.');
		}

		return new Promise((resolve) => {
			const child = cp.spawn(cli, args, { shell: false });
			let stdout = '';
			let stderr = '';

			child.stdout.on('data', (d) => {
				stdout += d.toString();
			});
			child.stderr.on('data', (d) => {
				stderr += d.toString();
			});

			child.on('close', (code) => {
				resolve({ stdout, stderr, code: code ?? 0 });
			});
			child.on('error', (err) => {
				resolve({ stdout, stderr: stderr + '\n' + err.message, code: 1 });
			});
		});
	}

	public async compile(sketchPath: string, fqbn: string): Promise<CompileResult> {
		const args = ['compile', '--fqbn', fqbn, '--format', 'json', sketchPath];
		const res = await this.execCli(args);

		if (res.code === 0) {
			try {
				const json = JSON.parse(res.stdout);
				return {
					success: true,
					compilerOutput: res.stdout,
					builderResult: json.builder_result
				};
			} catch {
				return {
					success: true,
					compilerOutput: res.stdout
				};
			}
		} else {
			return {
				success: false,
				compilerOutput: res.stdout,
				errorOutput: res.stderr || res.stdout
			};
		}
	}

	public async upload(sketchPath: string, fqbn: string, port: string): Promise<UploadResult> {
		const args = ['upload', '-p', port, '--fqbn', fqbn, sketchPath];
		const res = await this.execCli(args);
		return {
			success: res.code === 0,
			output: res.stdout,
			error: res.code !== 0 ? (res.stderr || res.stdout) : undefined
		};
	}

	public async listDetectedBoards(): Promise<ArduinoDetectedBoard[]> {
		const args = ['board', 'list', '--format', 'json'];
		const res = await this.execCli(args);
		if (res.code !== 0) {
			return [];
		}

		try {
			const json = JSON.parse(res.stdout);
			const boards: ArduinoDetectedBoard[] = [];
			const detectedList = json.detected_ports || [];
			for (const p of detectedList) {
				const matchingBoards = p.boards || [];
				for (const b of matchingBoards) {
					boards.push({
						name: b.name,
						fqbn: b.fqbn,
						port: {
							address: p.port.address,
							label: p.port.label,
							protocol: p.port.protocol,
							protocolLabel: p.port.protocol_label,
							properties: p.port.properties
						}
					});
				}
			}
			return boards;
		} catch {
			return [];
		}
	}

	public async getBoardDetails(fqbn: string): Promise<any | undefined> {
		try {
			const args = ['board', 'details', '-b', fqbn, '--format', 'json'];
			const res = await this.execCli(args);
			if (res.code === 0 && res.stdout) {
				return JSON.parse(res.stdout);
			}
		} catch (e) {
			console.warn(`[ArduinoCliService] Failed to get board details for ${fqbn}:`, e);
		}
		return undefined;
	}

	public async listAllInstalledBoards(): Promise<Array<{ name: string; fqbn: string }>> {
		try {
			const args = ['board', 'listall', '--format', 'json'];
			const res = await this.execCli(args);
			if (res.code === 0 && res.stdout) {
				const json = JSON.parse(res.stdout);
				if (Array.isArray(json.boards)) {
					return json.boards.map((b: any) => ({ name: b.name, fqbn: b.fqbn }));
				}
			}
		} catch (e) {
			console.warn('[ArduinoCliService] Failed to list all installed boards:', e);
		}
		return [];
	}

	public async searchLibraries(query: string): Promise<LibrarySearchResult[]> {
		const args = ['lib', 'search', query, '--format', 'json'];
		const res = await this.execCli(args);
		if (res.code !== 0) {
			return [];
		}

		try {
			const json = JSON.parse(res.stdout);
			const libraries = json.libraries || [];
			return libraries.map((lib: any) => {
				const latest = lib.latest || {};
				return {
					name: lib.name || latest.name,
					author: latest.author || '',
					maintainer: latest.maintainer || '',
					sentence: latest.sentence || '',
					paragraph: latest.paragraph || '',
					website: latest.website || '',
					category: latest.category || '',
					version: latest.version || '',
					installed: lib.installed ? lib.installed.version : undefined
				};
			});
		} catch {
			return [];
		}
	}

	public async installLibrary(libName: string): Promise<{ success: boolean; message: string }> {
		const args = ['lib', 'install', libName];
		const res = await this.execCli(args);
		return {
			success: res.code === 0,
			message: res.code === 0 ? res.stdout : (res.stderr || res.stdout)
		};
	}

	public async searchCores(query: string): Promise<CoreSearchResult[]> {
		const args = ['core', 'search', query, '--format', 'json'];
		const res = await this.execCli(args);
		if (res.code !== 0) {
			return [];
		}

		try {
			const json = JSON.parse(res.stdout);
			const platforms = json.platforms || [];
			return platforms.map((p: any) => ({
				id: p.id,
				name: p.name,
				maintainer: p.maintainer,
				latest: p.latest,
				installed: p.installed ? p.installed.version : undefined
			}));
		} catch {
			return [];
		}
	}

	public async installCore(coreName: string): Promise<{ success: boolean; message: string }> {
		const args = ['core', 'install', coreName];
		const res = await this.execCli(args);
		return {
			success: res.code === 0,
			message: res.code === 0 ? res.stdout : (res.stderr || res.stdout)
		};
	}
}

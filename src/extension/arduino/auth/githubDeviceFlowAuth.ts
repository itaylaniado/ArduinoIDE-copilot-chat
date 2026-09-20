/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface GitHubCopilotAppTokenEntry {
	user?: string;
	oauth_token: string;
	githubAppId?: string;
}

export class GitHubDeviceFlowAuth {
	private static _instance: GitHubDeviceFlowAuth | undefined;

	public static readonly CLIENT_ID = 'Iv1.b507a08c87ecfe98';
	public static readonly PROVIDER_ID = 'github';
	public static readonly PROVIDER_LABEL = 'GitHub';

	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationSessionsChangeEvent>();
	public readonly onDidChangeSessions: vscode.Event<vscode.AuthenticationSessionsChangeEvent> = this._onDidChangeSessions.event;

	private _currentSession: vscode.AuthenticationSession | undefined;
	private _isSigningIn = false;
	private _shimInstalled = false;

	private constructor() {
		this.loadSavedSession();
	}

	public static getInstance(): GitHubDeviceFlowAuth {
		if (!this._instance) {
			this._instance = new GitHubDeviceFlowAuth();
		}
		return this._instance;
	}

	public getAppsJsonPath(): string {
		return path.join(os.homedir(), '.config', 'github-copilot', 'apps.json');
	}

	/**
	 * Read stored credentials from ~/.config/github-copilot/apps.json
	 * (shared with ArduinoIDE-copilot-lsp and GitHub Copilot CLI)
	 */
	public readSavedToken(): { user: string; token: string } | undefined {
		const filePath = this.getAppsJsonPath();
		try {
			if (!fs.existsSync(filePath)) {
				return undefined;
			}
			const content = fs.readFileSync(filePath, 'utf8');
			const parsed = JSON.parse(content) as Record<string, GitHubCopilotAppTokenEntry>;
			for (const key of Object.keys(parsed)) {
				const entry = parsed[key];
				if (entry && typeof entry === 'object' && entry.oauth_token) {
					return {
						user: entry.user || 'github-user',
						token: entry.oauth_token
					};
				}
			}
		} catch (error) {
			console.error('[GitHubDeviceFlowAuth] Failed to read apps.json:', error);
		}
		return undefined;
	}

	/**
	 * Save token to ~/.config/github-copilot/apps.json
	 */
	public saveToken(user: string, token: string, appId: string = GitHubDeviceFlowAuth.CLIENT_ID): void {
		const filePath = this.getAppsJsonPath();
		try {
			const dir = path.dirname(filePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			let data: Record<string, any> = {};
			if (fs.existsSync(filePath)) {
				try {
					data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
				} catch {
					data = {};
				}
			}
			data[`github.com:${appId}`] = {
				user,
				oauth_token: token,
				githubAppId: appId
			};
			fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
		} catch (error) {
			console.error('[GitHubDeviceFlowAuth] Failed to save token to apps.json:', error);
		}
	}

	/**
	 * Remove token from ~/.config/github-copilot/apps.json
	 */
	public removeSavedToken(appId: string = GitHubDeviceFlowAuth.CLIENT_ID): void {
		const filePath = this.getAppsJsonPath();
		try {
			if (!fs.existsSync(filePath)) {
				return;
			}
			const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
			delete data[`github.com:${appId}`];
			fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
		} catch (error) {
			console.error('[GitHubDeviceFlowAuth] Failed to remove token from apps.json:', error);
		}
	}

	private loadSavedSession(): void {
		const saved = this.readSavedToken();
		if (saved) {
			this._currentSession = {
				id: `github-${saved.user}`,
				accessToken: saved.token,
				account: { id: saved.user, label: saved.user },
				scopes: ['read:user', 'user:email']
			};
		} else {
			this._currentSession = undefined;
		}
	}

	public getCurrentSession(): vscode.AuthenticationSession | undefined {
		if (!this._currentSession) {
			this.loadSavedSession();
		}
		return this._currentSession;
	}

	public async getAccounts(): Promise<vscode.AuthenticationSessionAccountInformation[]> {
		const session = this.getCurrentSession();
		if (session) {
			return [session.account];
		}
		return [];
	}

	public async getSession(
		scopes?: readonly string[],
		options?: vscode.AuthenticationGetSessionOptions
	): Promise<vscode.AuthenticationSession | undefined> {
		const session = this.getCurrentSession();
		if (session && !options?.forceNewSession) {
			return session;
		}

		if (options?.createIfNone || options?.forceNewSession) {
			return await this.signIn();
		}

		return undefined;
	}

	/**
	 * Run GitHub OAuth Device Flow (RFC 8628)
	 */
	public async signIn(): Promise<vscode.AuthenticationSession | undefined> {
		if (this._isSigningIn) {
			vscode.window.showInformationMessage('GitHub sign-in is already in progress.');
			return this._currentSession;
		}

		this._isSigningIn = true;
		try {
			// Step 1: Request Device Code
			const deviceResponse = await this.httpsRequest<{
				device_code: string;
				user_code: string;
				verification_uri: string;
				expires_in: number;
				interval: number;
			}>({
				hostname: 'github.com',
				path: '/login/device/code',
				method: 'POST',
				body: {
					client_id: GitHubDeviceFlowAuth.CLIENT_ID,
					scope: 'read:user,user:email'
				}
			});

			const { device_code, user_code, verification_uri, expires_in, interval } = deviceResponse;

			// Step 2: Copy userCode to clipboard and notify user
			let copied = false;
			try {
				await vscode.env.clipboard.writeText(user_code);
				copied = true;
			} catch {}

			const openGithub = 'Open GitHub';
			void vscode.window.showInformationMessage(
				`GitHub sign-in code: ${user_code}${copied ? ' (copied to clipboard)' : ''}. Please enter this code on GitHub to authorize.`,
				openGithub
			).then(selection => {
				if (selection === openGithub) {
					void vscode.env.openExternal(vscode.Uri.parse(verification_uri || 'https://github.com/login/device'));
				}
			});

			// Step 3: Poll for authorization token
			const intervalMs = Math.max((interval || 5) + 1, 3) * 1000;
			const expiresAt = Date.now() + Math.min(expires_in || 900, 900) * 1000;

			while (Date.now() < expiresAt) {
				await new Promise(r => setTimeout(r, intervalMs));

				const tokenResponse = await this.httpsRequest<{
					access_token?: string;
					error?: string;
					error_description?: string;
				}>({
					hostname: 'github.com',
					path: '/login/oauth/access_token',
					method: 'POST',
					body: {
						client_id: GitHubDeviceFlowAuth.CLIENT_ID,
						device_code,
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
					}
				});

				if (tokenResponse.access_token) {
					const accessToken = tokenResponse.access_token;
					const user = await this.fetchGitHubUsername(accessToken) || 'github-user';

					this.saveToken(user, accessToken);

					const newSession: vscode.AuthenticationSession = {
						id: `github-${user}`,
						accessToken,
						account: { id: user, label: user },
						scopes: ['read:user', 'user:email']
					};

					const oldSession = this._currentSession;
					this._currentSession = newSession;

					this._onDidChangeSessions.fire({
						added: oldSession ? [] : [newSession],
						removed: oldSession ? [oldSession] : [],
						changed: oldSession ? [newSession] : []
					});

					vscode.window.showInformationMessage(`Successfully signed in to GitHub Copilot as ${user}!`);
					return newSession;
				}

				if (tokenResponse.error === 'authorization_pending') {
					continue;
				}
				if (tokenResponse.error === 'slow_down') {
					await new Promise(r => setTimeout(r, 5000));
					continue;
				}
				if (tokenResponse.error) {
					throw new Error(tokenResponse.error_description || tokenResponse.error);
				}
			}

			throw new Error('Sign-in timed out. Please try again.');
		} catch (error: any) {
			vscode.window.showErrorMessage(`GitHub sign-in failed: ${error?.message || error}`);
			return undefined;
		} finally {
			this._isSigningIn = false;
		}
	}

	/**
	 * Sign out and clear stored token
	 */
	public async signOut(): Promise<void> {
		const oldSession = this._currentSession;
		this.removeSavedToken();
		this._currentSession = undefined;

		if (oldSession) {
			this._onDidChangeSessions.fire({
				added: [],
				removed: [oldSession],
				changed: []
			});
		}

		vscode.window.showInformationMessage('Signed out of GitHub Copilot.');
	}

	private async fetchGitHubUsername(accessToken: string): Promise<string | undefined> {
		try {
			const res = await this.httpsRequest<{ login?: string }>({
				hostname: 'api.github.com',
				path: '/user',
				method: 'GET',
				headers: {
					'Authorization': `token ${accessToken}`
				}
			});
			return res.login;
		} catch {
			return undefined;
		}
	}

	private httpsRequest<T>(options: {
		hostname: string;
		path: string;
		method: 'GET' | 'POST';
		body?: Record<string, any>;
		headers?: Record<string, string>;
	}): Promise<T> {
		return new Promise((resolve, reject) => {
			const postData = options.body ? JSON.stringify(options.body) : undefined;
			const reqHeaders: Record<string, string | number> = {
				'Accept': 'application/json',
				'User-Agent': 'ArduinoIDE-copilot-chat/0.44.0',
				...options.headers
			};

			if (postData) {
				reqHeaders['Content-Type'] = 'application/json';
				reqHeaders['Content-Length'] = Buffer.byteLength(postData);
			}

			const req = https.request({
				hostname: options.hostname,
				port: 443,
				path: options.path,
				method: options.method,
				headers: reqHeaders
			}, (res) => {
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					try {
						resolve(JSON.parse(data) as T);
					} catch (e) {
						reject(new Error(`Failed to parse response (${res.statusCode}): ${data}`));
					}
				});
			});

			req.on('error', reject);
			if (postData) {
				req.write(postData);
			}
			req.end();
		});
	}

	/**
	 * Expose as a vscode.AuthenticationProvider
	 */
	public asAuthenticationProvider(): vscode.AuthenticationProvider {
		return {
			onDidChangeSessions: this._onDidChangeSessions.event,
			getSessions: async (scopes?: readonly string[]) => {
				const session = await this.getSession(scopes);
				return session ? [session] : [];
			},
			createSession: async (scopes: readonly string[]) => {
				const session = await this.signIn();
				if (!session) {
					throw new Error('User cancelled sign-in');
				}
				return session;
			},
			removeSession: async () => {
				await this.signOut();
			}
		};
	}

	/**
	 * Install authentication shim onto vscode.authentication so all Copilot services
	 * can automatically query getSession('github') and getAccounts('github') without
	 * requiring proprietary VS Code extensions.
	 */
	public installShim(context?: vscode.ExtensionContext): void {
		if (this._shimInstalled) {
			return;
		}
		this._shimInstalled = true;

		const vsc = typeof require === 'function' ? require('vscode') : (vscode as any);
		if (!vsc) {
			return;
		}

		// 1. Hook up vscode.authentication if not defined or incomplete
		if (!vsc.authentication) {
			vsc.authentication = {};
		}

		const originalGetSession = vsc.authentication.getSession;
		vsc.authentication.getSession = async (providerId: string, scopes: readonly string[], options?: any) => {
			if (providerId === GitHubDeviceFlowAuth.PROVIDER_ID) {
				const session = await this.getSession(scopes, options);
				if (session) {
					return session;
				}
			}
			if (originalGetSession && typeof originalGetSession === 'function') {
				try {
					return await originalGetSession.call(vsc.authentication, providerId, scopes, options);
				} catch {
					return undefined;
				}
			}
			return undefined;
		};

		const originalGetAccounts = vsc.authentication.getAccounts;
		vsc.authentication.getAccounts = async (providerId: string) => {
			if (providerId === GitHubDeviceFlowAuth.PROVIDER_ID) {
				const accounts = await this.getAccounts();
				if (accounts.length > 0) {
					return accounts;
				}
			}
			if (originalGetAccounts && typeof originalGetAccounts === 'function') {
				try {
					return await originalGetAccounts.call(vsc.authentication, providerId);
				} catch {
					return [];
				}
			}
			return [];
		};

		// 2. Try registering official provider with vscode.authentication
		try {
			if (typeof vscode.authentication.registerAuthenticationProvider === 'function') {
				const providerDisposable = vscode.authentication.registerAuthenticationProvider(
					GitHubDeviceFlowAuth.PROVIDER_ID,
					GitHubDeviceFlowAuth.PROVIDER_LABEL,
					this.asAuthenticationProvider()
				);
				context?.subscriptions.push(providerDisposable);
			}
		} catch (error) {
			console.warn('[GitHubDeviceFlowAuth] Could not registerAuthenticationProvider directly:', error);
		}
	}
}

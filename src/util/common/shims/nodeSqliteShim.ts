/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

let nativeSqlite: any = null;
try {
	// Safely check if node:sqlite is available in this Node runtime
	nativeSqlite = eval('require("node:sqlite")');
} catch {
	// Not available in older Electron/Node environments (e.g. Arduino IDE 2.x)
}

export class StatementSync {
	constructor(private readonly _sql?: string) {}

	run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
		return { changes: 0, lastInsertRowid: 0 };
	}

	all(...params: any[]): any[] {
		return [];
	}

	get(...params: any[]): any {
		return undefined;
	}
}

export class DatabaseSync {
	private readonly _nativeDb: any = null;

	constructor(location?: string, options?: any) {
		if (nativeSqlite?.DatabaseSync) {
			try {
				this._nativeDb = new nativeSqlite.DatabaseSync(location, options);
			} catch {
				this._nativeDb = null;
			}
		}
	}

	exec(sql: string): void {
		if (this._nativeDb) {
			this._nativeDb.exec(sql);
		}
	}

	prepare(sql: string): StatementSync {
		if (this._nativeDb) {
			return this._nativeDb.prepare(sql);
		}
		return new StatementSync(sql);
	}

	close(): void {
		if (this._nativeDb) {
			this._nativeDb.close();
		}
	}
}

export interface DatabaseSyncOptions {
	open?: boolean;
	readOnly?: boolean;
	enableDefensive?: boolean;
}

const sqliteShim = {
	DatabaseSync,
	StatementSync
};

export default sqliteShim;

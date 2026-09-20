/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IArduinoCliService, LibrarySearchResult } from '../services/arduinoCliService';

export interface LibraryParams {
	action: 'search' | 'install';
	libraryName: string;
}

export interface LibraryToolOutput {
	success: boolean;
	message: string;
	results?: LibrarySearchResult[];
}

export class ArduinoLibraryTool {
	public static readonly toolName = 'arduino_library_manager';
	public static readonly description = 'Search for Arduino libraries in the official Library Index or install a library via arduino-cli.';

	constructor(private readonly arduinoCliService: IArduinoCliService) {}

	public async execute(params: LibraryParams): Promise<LibraryToolOutput> {
		if (params.action === 'install') {
			const res = await this.arduinoCliService.installLibrary(params.libraryName);
			return {
				success: res.success,
				message: res.success
					? `Library '${params.libraryName}' installed successfully.`
					: `Failed to install library '${params.libraryName}': ${res.message}`
			};
		} else {
			const results = await this.arduinoCliService.searchLibraries(params.libraryName);
			return {
				success: true,
				message: `Found ${results.length} library match(es) for '${params.libraryName}'.`,
				results: results.slice(0, 10) // top 10 results
			};
		}
	}
}

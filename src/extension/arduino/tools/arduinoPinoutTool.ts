/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IBoardContextService, BoardProfile } from '../services/boardContextService';

export interface PinoutParams {
	fqbn?: string;
	checkPin?: string | number;
	capability?: 'pwm' | 'analog' | 'interrupt' | 'i2c' | 'spi';
}

export interface PinoutOutput {
	board: BoardProfile;
	pinValidation?: {
		pin: string | number;
		capability: string;
		supported: boolean;
		warning?: string;
	};
	summary: string;
}

export class ArduinoPinoutTool {
	public static readonly toolName = 'arduino_pinout_checker';
	public static readonly description = 'Inspect microcontroller pinout, hardware capabilities (PWM, ADC, I2C, SPI, Interrupts), voltage levels, and validate pin assignments.';

	constructor(private readonly boardContextService: IBoardContextService) {}

	public async execute(params: PinoutParams): Promise<PinoutOutput> {
		const board = params.fqbn
			? (this.boardContextService.getProfile(params.fqbn) || this.boardContextService.getActiveBoard())
			: this.boardContextService.getActiveBoard();

		let pinValidation: PinoutOutput['pinValidation'];
		if (params.checkPin !== undefined && params.capability) {
			const res = this.boardContextService.validatePinCapability(params.checkPin, params.capability);
			pinValidation = {
				pin: params.checkPin,
				capability: params.capability,
				supported: res.supported,
				warning: res.warning
			};
		}

		let summary = `Board: ${board.name} (${board.fqbn})\n` +
			`- Operating Voltage: ${board.voltage}V\n` +
			`- Architecture: ${board.architecture} (${board.clockSpeedMhz} MHz)\n` +
			`- Flash Memory: ${(board.flashBytes / 1024).toFixed(1)} KB | SRAM: ${(board.sramBytes / 1024).toFixed(1)} KB\n` +
			`- PWM Pins: ${board.pwmPins.join(', ')}\n` +
			`- Analog Input Pins: ${board.analogInputPins.join(', ')}\n` +
			`- I2C: SDA=${board.i2cPins.sda}, SCL=${board.i2cPins.scl}\n` +
			`- SPI: MOSI=${board.spiPins.mosi}, MISO=${board.spiPins.miso}, SCK=${board.spiPins.sck}\n` +
			`- External Interrupts: ${board.interruptPins.join(', ')}`;

		if (board.notes && board.notes.length > 0) {
			summary += '\n\nImportant Hardware Notes:\n' + board.notes.map(n => `• ${n}`).join('\n');
		}

		if (pinValidation && pinValidation.warning) {
			summary += `\n\n⚠️ Pin Warning: ${pinValidation.warning}`;
		}

		return {
			board,
			pinValidation,
			summary
		};
	}
}

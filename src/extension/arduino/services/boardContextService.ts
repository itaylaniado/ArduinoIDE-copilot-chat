import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { IArduinoCliService } from './arduinoCliService';

export interface BoardProfile {
	name: string;
	fqbn: string;
	architecture: string;
	voltage: number; // in Volts, e.g. 5.0 or 3.3
	flashBytes: number;
	sramBytes: number;
	eepromBytes?: number;
	clockSpeedMhz: number;
	digitalPins: number[];
	pwmPins: number[];
	analogInputPins: string[];
	i2cPins: { sda: string | number; scl: string | number };
	spiPins: { mosi: string | number; miso: string | number; sck: string | number; ss?: string | number };
	interruptPins: number[];
	notes?: string[];
}

export const KNOWN_BOARDS: Record<string, BoardProfile> = {
	'arduino:avr:uno': {
		name: 'Arduino Uno',
		fqbn: 'arduino:avr:uno',
		architecture: 'avr',
		voltage: 5.0,
		flashBytes: 32256,
		sramBytes: 2048,
		eepromBytes: 1024,
		clockSpeedMhz: 16,
		digitalPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
		pwmPins: [3, 5, 6, 9, 10, 11],
		analogInputPins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
		i2cPins: { sda: 'A4', scl: 'A5' },
		spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
		interruptPins: [2, 3],
		notes: [
			'5V logic level. Connecting 3.3V sensors requires level shifting.',
			'Pins 0 and 1 are shared with hardware Serial (UART). Avoid using for GPIO when using Serial.',
			'Only 2KB SRAM. Use F() macro for string literals and avoid heavy String heap allocations.'
		]
	},
	'arduino:avr:nano': {
		name: 'Arduino Nano',
		fqbn: 'arduino:avr:nano',
		architecture: 'avr',
		voltage: 5.0,
		flashBytes: 30720,
		sramBytes: 2048,
		eepromBytes: 1024,
		clockSpeedMhz: 16,
		digitalPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
		pwmPins: [3, 5, 6, 9, 10, 11],
		analogInputPins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'],
		i2cPins: { sda: 'A4', scl: 'A5' },
		spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
		interruptPins: [2, 3],
		notes: [
			'A6 and A7 are analog-only and cannot be used as digital GPIO pins.'
		]
	},
	'arduino:avr:mega': {
		name: 'Arduino Mega 2560',
		fqbn: 'arduino:avr:mega',
		architecture: 'avr',
		voltage: 5.0,
		flashBytes: 258048,
		sramBytes: 8192,
		eepromBytes: 4096,
		clockSpeedMhz: 16,
		digitalPins: Array.from({ length: 54 }, (_, i) => i),
		pwmPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 44, 45, 46],
		analogInputPins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15'],
		i2cPins: { sda: 20, scl: 21 },
		spiPins: { mosi: 51, miso: 50, sck: 52, ss: 53 },
		interruptPins: [2, 3, 18, 19, 20, 21],
		notes: [
			'Includes 4 hardware UART serial ports: Serial, Serial1, Serial2, Serial3.'
		]
	},
	'arduino:avr:leonardo': {
		name: 'Arduino Leonardo',
		fqbn: 'arduino:avr:leonardo',
		architecture: 'avr',
		voltage: 5.0,
		flashBytes: 28672,
		sramBytes: 2560,
		eepromBytes: 1024,
		clockSpeedMhz: 16,
		digitalPins: Array.from({ length: 20 }, (_, i) => i),
		pwmPins: [3, 5, 6, 9, 10, 11, 13],
		analogInputPins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11'],
		i2cPins: { sda: 2, scl: 3 },
		spiPins: { mosi: 'ICSP-4', miso: 'ICSP-1', sck: 'ICSP-3', ss: 17 },
		interruptPins: [0, 1, 2, 3, 7],
		notes: [
			'ATmega32U4 with native USB (Keyboard / Mouse HID emulation support).',
			'SPI bus is only accessible via the 6-pin ICSP header, NOT digital pins 10-13.'
		]
	},
	'arduino:renesas_uno:unor4wifi': {
		name: 'Arduino UNO R4 WiFi',
		fqbn: 'arduino:renesas_uno:unor4wifi',
		architecture: 'renesas_uno',
		voltage: 5.0,
		flashBytes: 262144,
		sramBytes: 32768,
		eepromBytes: 8192,
		clockSpeedMhz: 48,
		digitalPins: Array.from({ length: 14 }, (_, i) => i),
		pwmPins: [3, 5, 6, 9, 10, 11],
		analogInputPins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
		i2cPins: { sda: 'A4', scl: 'A5' },
		spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
		interruptPins: [2, 3],
		notes: [
			'Renesas RA4M1 32-bit ARM Cortex-M4 CPU (48 MHz) with on-board ESP32-S3 for WiFi/BLE.',
			'Operates at 5V logic with 12x8 LED matrix and 12-bit DAC.'
		]
	},
	'arduino:renesas_uno:unor4minima': {
		name: 'Arduino UNO R4 Minima',
		fqbn: 'arduino:renesas_uno:unor4minima',
		architecture: 'renesas_uno',
		voltage: 5.0,
		flashBytes: 262144,
		sramBytes: 32768,
		eepromBytes: 8192,
		clockSpeedMhz: 48,
		digitalPins: Array.from({ length: 14 }, (_, i) => i),
		pwmPins: [3, 5, 6, 9, 10, 11],
		analogInputPins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
		i2cPins: { sda: 'A4', scl: 'A5' },
		spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
		interruptPins: [2, 3],
		notes: [
			'Renesas RA4M1 32-bit ARM Cortex-M4 CPU (48 MHz).',
			'5V logic level, USB-C native HID and CAN bus.'
		]
	},
	'esp32:esp32:esp32': {
		name: 'ESP32 Dev Module',
		fqbn: 'esp32:esp32:esp32',
		architecture: 'xtensa-esp32',
		voltage: 3.3,
		flashBytes: 4194304,
		sramBytes: 520000,
		clockSpeedMhz: 240,
		digitalPins: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39],
		pwmPins: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
		analogInputPins: ['GPIO36', 'GPIO39', 'GPIO34', 'GPIO35', 'GPIO32', 'GPIO33', 'GPIO25', 'GPIO26', 'GPIO27', 'GPIO14', 'GPIO12', 'GPIO13', 'GPIO15', 'GPIO2', 'GPIO4'],
		i2cPins: { sda: 21, scl: 22 },
		spiPins: { mosi: 23, miso: 19, sck: 18, ss: 5 },
		interruptPins: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
		notes: [
			'3.3V logic level! 5V signals on inputs WILL damage the ESP32.',
			'Pins 34, 35, 36, 39 are INPUT ONLY (no internal pull-up/down resistors or output capability).',
			'Strapping pins: GPIO 0, 2, 12, 15 determine boot mode; pull-ups/pull-downs must not interfere with boot.',
			'Dual-core Xtensa MCU with FreeRTOS multitasking and built-in Wi-Fi / Bluetooth.'
		]
	},
	'esp32:esp32:esp32s3': {
		name: 'ESP32-S3 Dev Module',
		fqbn: 'esp32:esp32:esp32s3',
		architecture: 'xtensa-esp32s3',
		voltage: 3.3,
		flashBytes: 8388608,
		sramBytes: 520000,
		clockSpeedMhz: 240,
		digitalPins: Array.from({ length: 49 }, (_, i) => i),
		pwmPins: Array.from({ length: 49 }, (_, i) => i),
		analogInputPins: ['GPIO1', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO5', 'GPIO6', 'GPIO7', 'GPIO8', 'GPIO9', 'GPIO10'],
		i2cPins: { sda: 8, scl: 9 },
		spiPins: { mosi: 11, miso: 13, sck: 12, ss: 10 },
		interruptPins: Array.from({ length: 49 }, (_, i) => i),
		notes: [
			'3.3V logic level! Dual-core Xtensa LX7 with Vector instructions for AI acceleration.',
			'Native USB CDC and JTAG debugging built-in.'
		]
	},
	'esp32:esp32:esp32c3': {
		name: 'ESP32-C3 Dev Module',
		fqbn: 'esp32:esp32:esp32c3',
		architecture: 'riscv32-esp32c3',
		voltage: 3.3,
		flashBytes: 4194304,
		sramBytes: 400000,
		clockSpeedMhz: 160,
		digitalPins: Array.from({ length: 22 }, (_, i) => i),
		pwmPins: Array.from({ length: 22 }, (_, i) => i),
		analogInputPins: ['GPIO0', 'GPIO1', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO5'],
		i2cPins: { sda: 8, scl: 9 },
		spiPins: { mosi: 6, miso: 5, sck: 4, ss: 7 },
		interruptPins: Array.from({ length: 22 }, (_, i) => i),
		notes: [
			'3.3V logic level! Single-core 32-bit RISC-V microcontroller (160 MHz).',
			'Wi-Fi 4 and Bluetooth 5 (LE) built-in.'
		]
	},
	'esp8266:esp8266:nodemcuv2': {
		name: 'NodeMCU 1.0 (ESP-12E Module)',
		fqbn: 'esp8266:esp8266:nodemcuv2',
		architecture: 'esp8266',
		voltage: 3.3,
		flashBytes: 4194304,
		sramBytes: 81920,
		clockSpeedMhz: 80,
		digitalPins: [0, 1, 2, 3, 4, 5, 9, 10, 12, 13, 14, 15, 16],
		pwmPins: [0, 1, 2, 3, 4, 5, 12, 13, 14, 15],
		analogInputPins: ['A0'],
		i2cPins: { sda: 4, scl: 5 },
		spiPins: { mosi: 13, miso: 12, sck: 14, ss: 15 },
		interruptPins: [0, 1, 2, 3, 4, 5, 12, 13, 14, 15],
		notes: [
			'3.3V logic level! Input A0 max voltage is 1.0V (or 3.3V on NodeMCU due to internal voltage divider).',
			'Pin D0 (GPIO16) is needed for Wake from Deep Sleep (connected to RST).'
		]
	},
	'rp2040:rp2040:rpipico': {
		name: 'Raspberry Pi Pico (RP2040)',
		fqbn: 'rp2040:rp2040:rpipico',
		architecture: 'arm-cortex-m0plus',
		voltage: 3.3,
		flashBytes: 2097152,
		sramBytes: 264000,
		clockSpeedMhz: 133,
		digitalPins: Array.from({ length: 30 }, (_, i) => i),
		pwmPins: Array.from({ length: 30 }, (_, i) => i),
		analogInputPins: ['A0 (GP26)', 'A1 (GP27)', 'A2 (GP28)', 'A3 (VSYS)', 'ADC4 (Temp)'],
		i2cPins: { sda: 4, scl: 5 },
		spiPins: { mosi: 19, miso: 16, sck: 18, ss: 17 },
		interruptPins: Array.from({ length: 30 }, (_, i) => i),
		notes: [
			'3.3V logic level.',
			'Dual ARM Cortex-M0+ cores, Programmable I/O (PIO) blocks.'
		]
	},
	'rp2040:rp2040:rpipicow': {
		name: 'Raspberry Pi Pico W',
		fqbn: 'rp2040:rp2040:rpipicow',
		architecture: 'arm-cortex-m0plus',
		voltage: 3.3,
		flashBytes: 2097152,
		sramBytes: 264000,
		clockSpeedMhz: 133,
		digitalPins: Array.from({ length: 30 }, (_, i) => i),
		pwmPins: Array.from({ length: 30 }, (_, i) => i),
		analogInputPins: ['A0 (GP26)', 'A1 (GP27)', 'A2 (GP28)', 'A3 (VSYS)', 'ADC4 (Temp)'],
		i2cPins: { sda: 4, scl: 5 },
		spiPins: { mosi: 19, miso: 16, sck: 18, ss: 17 },
		interruptPins: Array.from({ length: 30 }, (_, i) => i),
		notes: [
			'3.3V logic level. Equipped with Infineon CYW43439 Wi-Fi and Bluetooth.',
			'Onboard LED is connected to the CYW43439 module, not a GPIO pin (use WL_GPIO_LED).'
		]
	}
};

export function createProfileFromBoardDetails(fqbn: string, details: any): BoardProfile {
	const name = details.name || details.properties_id || fqbn;
	const platformArch = details.platform?.architecture;
	const fqbnParts = fqbn.split(':');
	const arch = (platformArch || (fqbnParts.length > 1 ? fqbnParts[1] : 'unknown')).toLowerCase();

	const propMap: Record<string, string> = {};
	if (Array.isArray(details.properties)) {
		for (const item of details.properties) {
			if (typeof item === 'string') {
				const eq = item.indexOf('=');
				if (eq > 0) {
					propMap[item.substring(0, eq).trim()] = item.substring(eq + 1).trim();
				}
			}
		}
	} else if (details.properties && typeof details.properties === 'object') {
		Object.assign(propMap, details.properties);
	}

	let flashBytes = 0;
	let sramBytes = 0;
	let clockSpeedMhz = 16;
	let voltage = 5.0;

	if (propMap['upload.maximum_size']) {
		flashBytes = parseInt(propMap['upload.maximum_size'], 10) || 0;
	}
	if (propMap['upload.maximum_data_size']) {
		sramBytes = parseInt(propMap['upload.maximum_data_size'], 10) || 0;
	}
	if (propMap['build.f_cpu']) {
		const hz = parseInt(propMap['build.f_cpu'].replace(/[^0-9]/g, ''), 10);
		if (hz > 0) {
			clockSpeedMhz = Math.round(hz / 1000000);
		}
	}

	const notes: string[] = [];
	if (arch.includes('esp32')) {
		voltage = 3.3;
		if (!flashBytes) flashBytes = 4 * 1024 * 1024;
		if (!sramBytes) sramBytes = 320 * 1024;
		if (!clockSpeedMhz || clockSpeedMhz === 16) clockSpeedMhz = 240;
		notes.push('3.3V logic level! 5V signals on inputs WILL damage the ESP32.');
		notes.push('Dual-core / RISC-V with FreeRTOS multitasking and built-in Wi-Fi / Bluetooth.');
	} else if (arch.includes('esp8266')) {
		voltage = 3.3;
		if (!flashBytes) flashBytes = 4 * 1024 * 1024;
		if (!sramBytes) sramBytes = 80 * 1024;
		if (!clockSpeedMhz || clockSpeedMhz === 16) clockSpeedMhz = 80;
		notes.push('3.3V logic level. Standard I2C: SDA=GPIO4, SCL=GPIO5.');
	} else if (arch.includes('rp2040') || arch.includes('rp2350')) {
		voltage = 3.3;
		if (!flashBytes) flashBytes = 2 * 1024 * 1024;
		if (!sramBytes) sramBytes = 264 * 1024;
		if (!clockSpeedMhz || clockSpeedMhz === 16) clockSpeedMhz = 133;
		notes.push('3.3V logic level. Dual ARM Cortex-M0+/Cortex-M33 with Programmable I/O (PIO).');
	} else if (arch.includes('renesas')) {
		voltage = 5.0;
		if (!flashBytes) flashBytes = 256 * 1024;
		if (!sramBytes) sramBytes = 32 * 1024;
		if (!clockSpeedMhz || clockSpeedMhz === 16) clockSpeedMhz = 48;
		notes.push('Arduino UNO R4 (Renesas RA4M1 32-bit ARM Cortex-M4). 5V tolerant, 12-bit DAC, CAN bus.');
	} else if (arch.includes('samd') || arch.includes('sam')) {
		voltage = 3.3;
		if (!flashBytes) flashBytes = 256 * 1024;
		if (!sramBytes) sramBytes = 32 * 1024;
		if (!clockSpeedMhz || clockSpeedMhz === 16) clockSpeedMhz = 48;
		notes.push('3.3V logic level. Native USB, 32-bit ARM Cortex core.');
	} else if (arch === 'avr') {
		voltage = 5.0;
		if (!flashBytes) flashBytes = 32256;
		if (!sramBytes) sramBytes = 2048;
		notes.push('5V logic level. Preserve SRAM by using F() macro for string literals.');
	} else {
		voltage = 3.3;
		if (!flashBytes) flashBytes = 65536;
		if (!sramBytes) sramBytes = 8192;
	}

	return {
		name,
		fqbn,
		architecture: arch,
		voltage,
		flashBytes,
		sramBytes,
		clockSpeedMhz,
		digitalPins: Array.from({ length: 20 }, (_, i) => i),
		pwmPins: [3, 5, 6, 9, 10, 11],
		analogInputPins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
		i2cPins: { sda: 'A4', scl: 'A5' },
		spiPins: { mosi: 11, miso: 12, sck: 13 },
		interruptPins: [2, 3],
		notes
	};
}

export function createFallbackProfile(fqbn: string): BoardProfile {
	const parts = fqbn.split(':');
	const vendor = parts[0] || 'arduino';
	const arch = (parts[1] || 'avr').toLowerCase();
	const boardId = parts[2] || 'uno';

	let prettyName = `${boardId.toUpperCase()} (${vendor})`;
	if (boardId.toLowerCase() === 'uno') prettyName = 'Arduino Uno';
	else if (boardId.toLowerCase() === 'nano') prettyName = 'Arduino Nano';
	else if (boardId.toLowerCase() === 'mega') prettyName = 'Arduino Mega';
	else if (boardId.toLowerCase() === 'esp32') prettyName = 'ESP32 Dev Module';
	else if (boardId.toLowerCase() === 'esp32s3') prettyName = 'ESP32-S3 Dev Module';

	return createProfileFromBoardDetails(fqbn, {
		name: prettyName,
		properties_id: boardId,
		platform: { architecture: arch }
	});
}

export function parseSketchYaml(yamlText: string): { fqbn?: string; profile?: string } {
	let defaultProfile: string | undefined;
	let defaultFqbn: string | undefined;

	const lines = yamlText.split(/\r?\n/);
	let currentProfile: string | undefined;
	const profileFqbns: Record<string, string> = {};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('#') || !trimmed) continue;

		const defProfMatch = trimmed.match(/^default_profile\s*:\s*([a-zA-Z0-9_-]+)/);
		if (defProfMatch) {
			defaultProfile = defProfMatch[1];
			continue;
		}

		const defFqbnMatch = trimmed.match(/^default_fqbn\s*:\s*([^\s#]+)/);
		if (defFqbnMatch) {
			defaultFqbn = defFqbnMatch[1];
			continue;
		}

		const profMatch = line.match(/^ {2}([a-zA-Z0-9_-]+)\s*:/);
		if (profMatch) {
			currentProfile = profMatch[1];
			continue;
		}

		if (currentProfile) {
			const fqbnMatch = trimmed.match(/^fqbn\s*:\s*([^\s#]+)/);
			if (fqbnMatch) {
				profileFqbns[currentProfile] = fqbnMatch[1];
			}
		}
	}

	if (defaultProfile && profileFqbns[defaultProfile]) {
		return { fqbn: profileFqbns[defaultProfile], profile: defaultProfile };
	}
	if (defaultFqbn) {
		return { fqbn: defaultFqbn };
	}
	const firstProf = Object.values(profileFqbns)[0];
	if (firstProf) {
		return { fqbn: firstProf };
	}
	return {};
}

export function resolveFqbn(query: string): string | undefined {
	const q = query.trim().toLowerCase();
	if (q.includes(':')) {
		return query.trim();
	}

	if (q.includes('uno r4') || q.includes('unor4') || q.includes('r4 wifi')) {
		return 'arduino:renesas_uno:unor4wifi';
	}
	if (q.includes('r4 minima')) {
		return 'arduino:renesas_uno:unor4minima';
	}
	if (q === 'uno' || q === 'arduino uno') {
		return 'arduino:avr:uno';
	}
	if (q === 'nano' || q === 'arduino nano') {
		return 'arduino:avr:nano';
	}
	if (q.includes('mega') || q.includes('2560')) {
		return 'arduino:avr:mega';
	}
	if (q.includes('leonardo') || q.includes('micro') || q.includes('32u4')) {
		return 'arduino:avr:leonardo';
	}
	if (q.includes('esp32-s3') || q.includes('esp32s3')) {
		return 'esp32:esp32:esp32s3';
	}
	if (q.includes('esp32-c3') || q.includes('esp32c3')) {
		return 'esp32:esp32:esp32c3';
	}
	if (q.includes('esp32-s2') || q.includes('esp32s2')) {
		return 'esp32:esp32:esp32s2';
	}
	if (q.includes('esp32') || q.includes('wroom') || q.includes('devkit')) {
		return 'esp32:esp32:esp32';
	}
	if (q.includes('pico w') || q.includes('picow')) {
		return 'rp2040:rp2040:rpipicow';
	}
	if (q.includes('pico') || q.includes('rp2040')) {
		return 'rp2040:rp2040:rpipico';
	}
	if (q.includes('esp8266') || q.includes('nodemcu')) {
		return 'esp8266:esp8266:nodemcuv2';
	}
	if (q.includes('mkr wifi') || q.includes('mkr1010')) {
		return 'arduino:samd:mkrwifi1010';
	}
	if (q.includes('nano 33 iot') || q.includes('nano33iot')) {
		return 'arduino:samd:nano_33_iot';
	}
	if (q.includes('nano 33 ble') || q.includes('nano33ble')) {
		return 'arduino:mbed_nano:nano33ble';
	}

	return undefined;
}

export interface IBoardContextService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeBoard: Event<BoardProfile>;
	getActiveBoard(): BoardProfile;
	setActiveBoard(fqbn: string, boardDetails?: any): void;
	getActivePort(): string | undefined;
	setActivePort(port: string | undefined): void;
	getProfile(fqbn: string): BoardProfile | undefined;
	resolveFqbn(query: string): string | undefined;
	attachArduinoApi(): Promise<boolean>;
	validatePinCapability(pin: string | number, capability: 'pwm' | 'analog' | 'interrupt' | 'i2c' | 'spi'): {
		supported: boolean;
		warning?: string;
	};
}

export const IBoardContextService = createServiceIdentifier<IBoardContextService>('IBoardContextService');

export class BoardContextService extends Disposable implements IBoardContextService {
	declare _serviceBrand: undefined;

	private _activeFqbn: string = 'arduino:avr:uno';
	private _activePort: string | undefined;
	private readonly _dynamicBoards = new Map<string, BoardProfile>();
	private _arduinoApiAttached = false;

	private readonly _onDidChangeBoard = this._register(new Emitter<BoardProfile>());
	public readonly onDidChangeBoard: Event<BoardProfile> = this._onDidChangeBoard.event;

	constructor(
		@IArduinoCliService private readonly arduinoCliService?: IArduinoCliService
	) {
		super();
		this.detectInitialBoard();
		this.attachArduinoApi();

		// Re-detect board when user switches active sketch tab
		this._register(vscode.window.onDidChangeActiveTextEditor(() => {
			this.detectInitialBoard();
		}));

		// Check again if extensions change or finish initializing
		this._register(vscode.extensions.onDidChange(() => {
			this.attachArduinoApi();
		}));

		// Fallback polling attempts for IDE initialization
		setTimeout(() => this.attachArduinoApi(), 1000);
		setTimeout(() => this.attachArduinoApi(), 3000);
	}

	/**
	 * Attach to Arduino IDE 2.x's official extension API (dankeboy36.vscode-arduino-api).
	 * Subscribes to real-time changes when the user chooses a different board/port in the IDE toolbar.
	 */
	public async attachArduinoApi(): Promise<boolean> {
		try {
			const ext = vscode.extensions.getExtension('dankeboy36.vscode-arduino-api');
			if (!ext) {
				return false;
			}

			let api = ext.exports;
			if (!ext.isActive) {
				try {
					api = await ext.activate();
				} catch (e) {
					console.warn('[BoardContextService] Error activating vscode-arduino-api:', e);
				}
			}

			if (!api) {
				api = ext.exports;
			}

			if (api) {
				if (!this._arduinoApiAttached) {
					this._arduinoApiAttached = true;
					console.log('[BoardContextService] Successfully attached to Arduino IDE API (vscode-arduino-api)');
				}

				// 1. Synchronize initial board if already selected in the IDE
				if (api.fqbn) {
					console.log(`[BoardContextService] Synced FQBN from Arduino IDE: ${api.fqbn}`);
					this.setActiveBoard(api.fqbn, api.boardDetails);
				}
				if (api.port) {
					const portStr = typeof api.port === 'string' ? api.port : (api.port.address || api.port.label);
					if (portStr) {
						this.setActivePort(portStr);
					}
				}

				// 2. Listen to real-time events when user changes board or port in IDE dropdown
				if (typeof api.onDidChange === 'function') {
					try {
						this._register(api.onDidChange('fqbn')((newFqbn: string) => {
							console.log(`[BoardContextService] Board changed in Arduino IDE: ${newFqbn}`);
							if (newFqbn) {
								this.setActiveBoard(newFqbn, api.boardDetails);
							}
						}));
					} catch (e) {
						console.warn('[BoardContextService] Error subscribing to onDidChange(fqbn):', e);
					}

					try {
						this._register(api.onDidChange('port')((newPort: any) => {
							const portStr = typeof newPort === 'string' ? newPort : (newPort?.address || newPort?.label);
							console.log(`[BoardContextService] Port changed in Arduino IDE: ${portStr}`);
							this.setActivePort(portStr);
							this._onDidChangeBoard.fire(this.getActiveBoard());
						}));
					} catch (e) {
						console.warn('[BoardContextService] Error subscribing to onDidChange(port):', e);
					}

					try {
						this._register(api.onDidChange('boardDetails')((details: any) => {
							console.log('[BoardContextService] Board details updated in Arduino IDE');
							if (details && details.fqbn) {
								this.setActiveBoard(details.fqbn, details);
							}
						}));
					} catch (e) {
						console.warn('[BoardContextService] Error subscribing to onDidChange(boardDetails):', e);
					}
				}
				return true;
			}
		} catch (err) {
			console.warn('[BoardContextService] Exception while attaching to vscode-arduino-api:', err);
		}
		return false;
	}

	private detectInitialBoard(): void {
		// 1. Try reading sketch.yaml or .vscode/arduino.json in workspace/sketch directories
		const candidateFolders: string[] = [];
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			const activeFile = activeEditor.document.uri.fsPath;
			if (activeFile.endsWith('.ino') || activeFile.endsWith('.cpp') || activeFile.endsWith('.h')) {
				candidateFolders.push(path.dirname(activeFile));
			}
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			for (const wf of workspaceFolders) {
				candidateFolders.push(wf.uri.fsPath);
			}
		}

		for (const folder of candidateFolders) {
			const sketchYamlPath = path.join(folder, 'sketch.yaml');
			if (fs.existsSync(sketchYamlPath)) {
				try {
					const content = fs.readFileSync(sketchYamlPath, 'utf8');
					const parsed = parseSketchYaml(content);
					if (parsed.fqbn) {
						console.log(`[BoardContextService] Found FQBN from sketch.yaml: ${parsed.fqbn}`);
						this._activeFqbn = parsed.fqbn;
						return;
					}
				} catch {}
			}

			const arduinoJsonPath = path.join(folder, '.vscode', 'arduino.json');
			if (fs.existsSync(arduinoJsonPath)) {
				try {
					const content = fs.readFileSync(arduinoJsonPath, 'utf8');
					const json = JSON.parse(content);
					if (json.board) {
						this._activeFqbn = json.board;
					}
					if (json.port) {
						this._activePort = json.port;
					}
					return;
				} catch {}
			}
		}

		// 2. Check configuration setting
		const configFqbn = vscode.workspace.getConfiguration('arduino.copilot').get<string>('defaultFqbn');
		if (configFqbn) {
			this._activeFqbn = configFqbn;
		}
	}

	public getActiveBoard(): BoardProfile {
		return this.getProfile(this._activeFqbn) || createFallbackProfile(this._activeFqbn);
	}

	public setActiveBoard(fqbn: string, boardDetails?: any): void {
		if (boardDetails) {
			const profile = createProfileFromBoardDetails(fqbn, boardDetails);
			this._dynamicBoards.set(fqbn, profile);
		} else if (!this._dynamicBoards.has(fqbn) && !KNOWN_BOARDS[fqbn] && this.arduinoCliService) {
			// Query arduino-cli in background to get full details for unknown boards
			this.arduinoCliService.getBoardDetails(fqbn).then((details) => {
				if (details) {
					const profile = createProfileFromBoardDetails(fqbn, details);
					this._dynamicBoards.set(fqbn, profile);
					this._onDidChangeBoard.fire(this.getActiveBoard());
				}
			}).catch(() => {});
		}

		if (this._activeFqbn !== fqbn) {
			this._activeFqbn = fqbn;
			this._onDidChangeBoard.fire(this.getActiveBoard());
		}
	}

	public getActivePort(): string | undefined {
		return this._activePort;
	}

	public setActivePort(port: string | undefined): void {
		this._activePort = port;
	}

	public getProfile(fqbn: string): BoardProfile | undefined {
		return this._dynamicBoards.get(fqbn) || KNOWN_BOARDS[fqbn];
	}

	public resolveFqbn(query: string): string | undefined {
		return resolveFqbn(query);
	}

	public validatePinCapability(pin: string | number, capability: 'pwm' | 'analog' | 'interrupt' | 'i2c' | 'spi'): {
		supported: boolean;
		warning?: string;
	} {
		const board = this.getActiveBoard();
		const numPin = typeof pin === 'string' ? parseInt(pin.replace(/\D/g, ''), 10) : pin;
		const strPin = String(pin).toUpperCase();

		switch (capability) {
			case 'pwm': {
				const isPwm = !isNaN(numPin) && board.pwmPins.includes(numPin);
				return {
					supported: isPwm,
					warning: isPwm ? undefined : `Pin ${pin} does NOT support PWM (analogWrite) on ${board.name}. Supported PWM pins are: ${board.pwmPins.join(', ')}.`
				};
			}
			case 'analog': {
				const isAnalog = board.analogInputPins.some(p => p.toUpperCase().includes(strPin));
				return {
					supported: isAnalog,
					warning: isAnalog ? undefined : `Pin ${pin} is NOT an analog input pin on ${board.name}. Supported analog pins are: ${board.analogInputPins.join(', ')}.`
				};
			}
			case 'interrupt': {
				const isInt = !isNaN(numPin) && board.interruptPins.includes(numPin);
				return {
					supported: isInt,
					warning: isInt ? undefined : `Pin ${pin} does NOT support hardware external interrupts on ${board.name}. Supported interrupt pins are: ${board.interruptPins.join(', ')}.`
				};
			}
			case 'i2c': {
				const isI2c = String(board.i2cPins.sda) === String(pin) || String(board.i2cPins.scl) === String(pin);
				return {
					supported: isI2c,
					warning: isI2c ? undefined : `Pin ${pin} is not the standard hardware I2C pin on ${board.name}. Standard pins: SDA=${board.i2cPins.sda}, SCL=${board.i2cPins.scl}.`
				};
			}
			case 'spi': {
				const isSpi = String(board.spiPins.mosi) === String(pin) ||
					String(board.spiPins.miso) === String(pin) ||
					String(board.spiPins.sck) === String(pin);
				return {
					supported: isSpi,
					warning: isSpi ? undefined : `Pin ${pin} is not a standard SPI hardware bus pin on ${board.name}. Standard pins: MOSI=${board.spiPins.mosi}, MISO=${board.spiPins.miso}, SCK=${board.spiPins.sck}.`
				};
			}
		}
	}
}

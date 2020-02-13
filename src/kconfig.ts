import * as vscode from 'vscode';
import { resolveExpression, createExpression, Expression } from './evaluate';
import {ParsedFile} from './parse';

export type ConfigValue = string | number | boolean;
export type ConfigValueRange = { max: string, min: string, condition?: Expression };
export type ConfigValueType = 'string' | 'int' | 'hex' | 'bool' | 'tristate';
export type ConfigOverride = { config: Config, value: string, line?: number };
export type ConfigKind = 'config' | 'menuconfig' | 'choice';
export type ConfigDefault = {value: string, condition?: Expression};
export type ConfigSelect = {name: string, condition?: Expression};
export type LineRange = {start: number, end: number};

export abstract class Scope {
	lines: LineRange;
	name: string;
	file: ParsedFile;
	parent?: Scope;
	id: string;
	symbolKind: vscode.SymbolKind;

	constructor(type: string, name: string, line: number, file: ParsedFile, symbolKind: vscode.SymbolKind, parent?: Scope) {
		this.name = name;
		this.lines = {start: line, end: line};
		this.file = file;
		this.parent = parent;
		this.id = type + '(' + name + ')';
		this.symbolKind = symbolKind;

		if (parent) {
			this.id = parent.id + '::' + this.id;
		}
	}

	get range(): vscode.Range {
		return new vscode.Range(this.lines.start, 0, this.lines.end, 9999);
	}

	match(other: Scope): boolean {
		return this.id === other.id;
	}

	abstract evaluate(repo: Repository, overrides: ConfigOverride[]): boolean;
}

export class IfScope extends Scope {
	expr?: Expression;
	constructor(expression: string, line: number, file: ParsedFile, parent?: Scope) {
		super('if', expression, line, file, vscode.SymbolKind.Interface, parent);
		/* Creating the expression now incurs a 30% performance penalty on parsing,
		 * but makes config file evaluation MUCH faster */
		this.expr = createExpression(expression);
	}

	evaluate(repo: Repository, overrides: ConfigOverride[]) {
		return !!(this.expr?.solve(repo, overrides) ?? true); // default to false instead?
	}
}

export class MenuScope extends Scope {
	dependencies: string[];
	constructor(prompt: string, line: number, file: ParsedFile, parent?: Scope) {
		super('menu', prompt, line, file, vscode.SymbolKind.Class, parent);
		this.dependencies = [];
	}

	evaluate(repo: Repository, overrides: ConfigOverride[]) {
		return this.dependencies.every(d => resolveExpression(d, repo, overrides));
	}
}

export class ChoiceScope extends Scope {
	choice: ConfigEntry;
	constructor(choice: ConfigEntry) {
		super('choice', choice.config.name, choice.lines.start, choice.file, vscode.SymbolKind.Enum, choice.scope);
		this.choice = choice;
	}

	// Override name property to dynamically get it from the ConfigEntry:
	get name(): string {
		return this.choice.text || this.choice.config.name;
	}
	set name(name: string) {}

	evaluate(repo: Repository, overrides: ConfigOverride[]) {
		return true;
	}
}

export class ConfigEntry {
	config: Config;
	lines: LineRange;
	file: ParsedFile;
	help?: string;
	scope?: Scope;
	ranges: ConfigValueRange[];
	type?: ConfigValueType;
	text?: string;
	dependencies: string[];
	selects: ConfigSelect[];
	implys: ConfigSelect[];
	defaults: ConfigDefault[];

	constructor(config: Config, line: number, file: ParsedFile, scope?: Scope) {
		this.config = config;
		this.lines = {start: line, end: line};
		this.file = file;
		this.scope = scope;
		this.ranges = [];
		this.dependencies = [];
		this.selects = [];
		this.implys = [];
		this.defaults = [];

		this.config.entries.push(this);
	}

	extend(lineNumber: number)  {
		if (lineNumber < this.lines.start) {
			throw new Error("Extending upwards, shouldn't be possible.");
		}
		if (lineNumber <= this.lines.end) {
			return;
		}

		this.lines.end = lineNumber;
	}

	get loc(): vscode.Location {
		return new vscode.Location(this.file.uri, new vscode.Range(this.lines.start, 0, this.lines.end, 99999));
	}

	isActive(repo: Repository, overrides: ConfigOverride[]): boolean {
		return !this.scope || this.scope.evaluate(repo, overrides);
	}
}

export class Config {
	name: string;
	kind: ConfigKind;
	entries: ConfigEntry[];
	readonly repo: Repository;

	constructor(name: string, kind: ConfigKind, repo: Repository) {
		this.name = name;
		this.kind = kind;
		this.repo = repo;
		this.entries = [];
	}

	get type(): ConfigValueType | undefined {
		return this.entries.find(e => e.type)?.type;
	}

	get help(): string {
		return this.entries.filter(e => e.help).map(e => e.help).join('\n\n');
	}

	get text(): string | undefined {
		return this.entries.find(e => e.text)?.text;
	}

	get defaults(): ConfigDefault[] {
		var defaults: ConfigDefault[] = [];
		this.entries.forEach(e => defaults.push(...e.defaults));
		return defaults;
	}

	get ranges(): ConfigValueRange[] {
		var ranges: ConfigValueRange[] = [];
		this.entries.forEach(e => ranges.push(...e.ranges));
		return ranges;
	}

	get dependencies(): string[] {
		var dependencies: string[] = [];
		this.entries.forEach(e => dependencies.push(...e.dependencies));
		return dependencies;
	}

	get selects(): ConfigSelect[] {
		var selects: ConfigSelect[] = [];
		this.entries.forEach(e => selects.push(...e.selects));
		return selects;
	}

	get implys(): ConfigSelect[] {
		var implys: ConfigSelect[] = [];
		this.entries.forEach(e => implys.push(...e.implys));
		return implys;
	}

	removeEntry(entry: ConfigEntry) {
		var i = this.entries.indexOf(entry);
		this.entries.splice(i, 1);

		if (this.entries.length === 0) {
			delete this.repo.configs[this.name];
		}
	}

	isValidOverride(overrideValue: string): boolean {
		switch (this.type) {
			case 'bool':
				return ['y', 'n'].includes(overrideValue);
			case 'tristate':
				return ['y', 'n', 'm'].includes(overrideValue);
			case 'hex':
				return !!overrideValue.match(/^0x[a-fA-F\d]+/);
			case 'int':
				return !!overrideValue.match(/^\d+/);
			case 'string':
				return !!overrideValue.match(/^"[^"]*"/);
			default:
				return false;
		}
	}

	defaultValue(repo: Repository, overrides: ConfigOverride[] = []): ConfigValue {
		var dflt: ConfigDefault | undefined;
		this.entries.filter(e => e.isActive(repo, overrides)).some(e => {
			dflt = e.defaults.find(d => !d.condition || d.condition.solve(repo, overrides) === true);
			return dflt;
		});

		if (dflt) {
			return resolveExpression(dflt.value, repo, overrides);
		}

		return false;
	}

	isEnabled(value?: string) {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return (value === undefined) ? this.defaults.some(d => d.value === 'y') : (value === 'y');
			case 'int':
				return (value === undefined) ? this.defaults.some(d => d.value !== '0') : (value !== '0');
			case 'hex':
				return (value === undefined) ? this.defaults.some(d => d.value !== '0x0') : (value !== '0x0');
			default:
				return true;
		}
	}

	resolveValueString(value: string): ConfigValue {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return value === 'y' || value === 'm';
			case 'int':
			case 'hex':
				return Number(value);
			case 'string':
				return value;
			default:
				return false;
		}
	}

	toValueString(value: ConfigValue): string {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return value ? 'y' : 'n';
			case 'int':
				return value.toString(10);
			case 'hex':
				return '0x' + value.toString(16);
			case 'string':
				return `"${value}"`;
			default:
				return 'n';
		}
	}

	getRange(repo: Repository, overrides: ConfigOverride[] = []): {min: number, max: number} {
		var range: ConfigValueRange | undefined;
		this.entries.filter(e => e.isActive(repo, overrides)).find(e => {
			range = e.ranges.find(r => r.condition === undefined || r.condition.solve(repo, overrides) === true);
			return range;
		});

		if (range) {
			return {
				min: this.evaluateSymbol(range.min, repo, overrides) as number,
				max: this.evaluateSymbol(range.max, repo, overrides) as number,
			};
		}

		return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };

	}

	evaluateSymbol(name: string, repo: Repository, overrides: ConfigOverride[] = []): ConfigValue {
		if (name.match(/^\s*(0x[\da-fA-F]+|[\-+]?\d+)\s*$/)) {
			return Number(name);
		} else if (name.match(/^\s*[ynm]\s*$/)) {
			return name.trim() !== 'n';
		}

		var symbol = repo.configs[name];
		if (!symbol) {
			return false;
		}
		return symbol.evaluate(repo, overrides);
	}

	missingDependency(repo: Repository, overrides: ConfigOverride[] = []): string | undefined {
		return this.dependencies.find(d => !resolveExpression(d, repo, overrides));
	}

	selector(repo: Repository, overrides: ConfigOverride[] = []) {
		if (this.type !== 'bool' && this.type !== 'tristate') {
			return undefined;
		}

		var selectorFilter = (s: { name: string, condition?: Expression }) => {
			return s.name === this.name && (s.condition === undefined || s.condition.solve(repo, overrides));
		};

		var select = overrides.find(
			o => (
				(o.config.type === 'bool' || o.config.type === 'tristate') &&
				o.config.isEnabled(o.value) &&
				o.config.selects.some(selectorFilter)
			)
		) || Object.values(repo.configs).find(
			c => (
				(c.type === 'bool' || c.type === 'tristate') &&
				c.selects.some(selectorFilter) &&
				c.evaluate(repo, overrides)
			)
		);

		return select;
	}

	evaluate(repo: Repository, overrides: ConfigOverride[] = []): ConfigValue {
		// All dependencies must be true
		if (this.missingDependency(repo, overrides)) {
			return false;
		}

		var override = overrides.find(o => o.config.name === this.name);
		if (override) {
			return this.resolveValueString(override.value);
		}

		if (this.selector(repo, overrides)) {
			return true;
		}

		return this.defaultValue(repo, overrides) || false;
	}

	symbolKind(): vscode.SymbolKind {
		switch (this.kind) {
			case "choice":
				return vscode.SymbolKind.Enum;
			case "menuconfig":
				return vscode.SymbolKind.Class;
			case "config":
				switch (this.type) {
					case "bool": return vscode.SymbolKind.Property;
					case "tristate": return vscode.SymbolKind.EnumMember;
					case "int": return vscode.SymbolKind.Number;
					case "hex": return vscode.SymbolKind.Number;
					case "string": return vscode.SymbolKind.String;
				}
				/* Intentionall fall-through: Want undefined types to be handled like undefined kinds */
			case undefined:
				return vscode.SymbolKind.Null;
		}
	}

	completionKind(): vscode.CompletionItemKind {
		switch (this.kind) {
			case "choice":
				return vscode.CompletionItemKind.Class;
			case "menuconfig":
				return vscode.CompletionItemKind.Field;
			case "config":
				switch (this.type) {
					case "bool": return vscode.CompletionItemKind.Field;
					case "tristate": return vscode.CompletionItemKind.Field;
					case "int": return vscode.CompletionItemKind.Property;
					case "hex": return vscode.CompletionItemKind.Property;
					case "string": return vscode.CompletionItemKind.Keyword;
				}
				/* Intentional fall-through: Want undefined types to be handled like undefined kinds */
			case undefined:
				return vscode.CompletionItemKind.Property;
		}
	}
}

export class Repository {
	configs: {[name: string]: Config};
	root?: ParsedFile;
	diags: vscode.DiagnosticCollection;
	openEditors: vscode.Uri[];

	constructor(diags: vscode.DiagnosticCollection) {
		this.configs = {};
		this.diags = diags;

		this.openEditors = vscode.window.visibleTextEditors.filter(e => e.document.languageId === "kconfig").map(e => e.document.uri);
		this.openEditors.forEach(uri => this.setDiags(uri));

		vscode.window.onDidChangeVisibleTextEditors(e => {
			e = e.filter(e => e.document.languageId === 'kconfig');
			var newUris = e.map(e => e.document.uri);
			var removed = this.openEditors.filter(old => !newUris.some(uri => uri.fsPath === old.fsPath));
			var added = newUris.filter(newUri => !this.openEditors.some(uri => uri.fsPath === newUri.fsPath));

			removed.forEach(removed => this.diags.delete(removed));
			added.forEach(add => this.setDiags(add));

			this.openEditors = newUris;
		});
	}

	setRoot(uri: vscode.Uri) {
		this.configs = {};
		this.root = new ParsedFile(this, uri, {});
	}

	parse() {
		this.root?.parse();
		this.openEditors.forEach(uri => this.setDiags(uri));
	}

	reset() {
		if (this.root) {
			this.setRoot(this.root.uri);
			this.parse();
		}
	}

	get files(): ParsedFile[] { // TODO: optimize to a managed dict?
		if (!this.root) {
			return [];
		}

		return [this.root, ...this.root.children()];
	}

	setDiags(uri: vscode.Uri) {
		this.diags.set(uri,
			this.files
				.filter(f => f.uri.fsPath === uri.fsPath)
				.map(f => f.diags)
				.reduce((sum, diags) => sum.concat(diags.filter(d => !sum.some(existing => existing.range.start.line === d.range.start.line))), []));
	}

	onDidChange(uri: vscode.Uri, change?: vscode.TextDocumentChangeEvent) {
		if (change && change.contentChanges.length === 0) {
			return;
		}

		var hrTime = process.hrtime();

		var files = this.files.filter(f => f.uri.fsPath === uri.fsPath);

		files.forEach(f => f.onDidChange(change));
		hrTime = process.hrtime(hrTime);

		this.openEditors.forEach(uri => this.setDiags(uri));

		console.log(`Handled changes to ${files.length} versions of ${uri.fsPath} in ${hrTime[0] * 1000 + hrTime[1] / 1000000} ms.`);
		console.log(`\tFiles: ${this.files.length}`);
		console.log(`\tConfigs: ${Object.values(this.configs).length}`);
		console.log(`\tEmpty configs: ${Object.values(this.configs).filter(c => c.entries.length === 0).length}`);
	}
}

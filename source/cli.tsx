#!/usr/bin/env node
import meow from 'meow';
import {runApply} from './exec/apply.js';
import {renderEnvelope, EXIT} from './exec/envelope.js';
import {runPropose} from './exec/propose.js';
import {runExec, type ExecResult} from './exec/runner.js';
import {resolveStartup} from './vault/projects.js';

const cli = meow(
	`
	Usage
	  $ litfire [vault]
	  $ litfire exec <vault> /<command> [args] [--json]
	  $ litfire exec <vault> /ingest <kind> --propose --out <file>
	  $ litfire review apply <file> --accept 1,3 | --accept-all <n>

	  litfire <path>   open that vault
	  litfire .        open the current directory
	  litfire          reopen the last vault you worked in

	Options
	  --no-watch              Do not reload when the vault changes on disk
	  --json                  Emit the exec envelope as JSON
	  --yes                   Answer a command's yes/no question with yes
	  --propose               Build a review batch and write it out; apply nothing
	  --out <file>            Where to write the batch (required with --propose)
	  --again                 Re-read notes the corpus already reflects
	  --accept <n,n>          Items to apply, by index
	  --accept-all <n>        Apply every item, asserting there are n of them
	  --allow-derived-write   Permit a command that regenerates wiki/ and ledger/

	Exit codes
	  0 ok · 1 command error · 2 usage · 3 refused in exec mode
	  4 stale batch · 5 consent required · 6 no provider

	Examples
	  $ litfire ~/novels/inanna-2
	  $ litfire exec ~/novels/inanna-2 /questions --json
	  $ litfire exec ~/novels/inanna-2 /ingest character --propose --out /tmp/b.json
	  $ litfire review apply /tmp/b.json --accept 1,2
	  $ litfire review apply /tmp/b.json --accept-all 3
`,
	{
		importMeta: import.meta,
		// Everything after the command is the command's own, so meow must not
		// eat a flag that belongs to it.
		allowUnknownFlags: true,
		flags: {
			watch: {type: 'boolean', default: true},
			json: {type: 'boolean', default: false},
			yes: {type: 'boolean', default: false},
			propose: {type: 'boolean', default: false},
			out: {type: 'string'},
			again: {type: 'boolean', default: false},
			accept: {type: 'string'},
			acceptAll: {type: 'number'},
			allowDerivedWrite: {type: 'boolean', default: false},
		},
	},
);

const version = cli.pkg.version ?? '0.0.0';

/**
 * The headless surface is decided before anything renders.
 *
 * Ink is imported dynamically below, and only on the interactive path. Ink
 * writing to a non-TTY is a real failure mode, and the structural fix — never
 * constructing it — is worth more than a runtime `isTTY` check that is one
 * refactor away from being bypassed.
 */
function report(result: ExecResult): never {
	process.stdout.write(
		cli.flags.json
			? `${JSON.stringify(result.envelope, null, 2)}\n`
			: `${renderEnvelope(result.envelope)}\n`,
	);
	process.exit(result.code);
}

const [verb, ...rest] = cli.input;

if (verb === 'review') {
	const [action, batchFile] = rest;
	if (action !== 'apply' || batchFile === undefined) {
		process.stderr.write(
			'usage: litfire review apply <file> --accept 1,3 | --accept-all <n>\n',
		);
		process.exit(EXIT.usageError);
	}

	// `--accept-all` with nothing after it is the exact mistake the count exists
	// to prevent, so it is caught here rather than defaulting to anything.
	if (process.argv.includes('--accept-all') && cli.flags.acceptAll === undefined) {
		process.stderr.write(
			'--accept-all needs the number of items you expect, e.g. --accept-all 3\n',
		);
		process.exit(EXIT.usageError);
	}

	report(
		await runApply({
			batchFile,
			accept: (cli.flags.accept ?? '')
				.split(',')
				.map(part => Number.parseInt(part.trim(), 10))
				.filter(value => Number.isInteger(value)),
			acceptAll: cli.flags.acceptAll,
			version,
		}),
	);
}

if (verb === 'exec') {
	const [vault, ...argv] = rest;
	if (vault === undefined || argv.length === 0) {
		process.stderr.write('usage: litfire exec <vault> /<command> [args]\n');
		process.exit(EXIT.usageError);
	}

	// The same resolver the TUI uses, so both agree on which vault is meant.
	// It reads; `rememberProject` is App's alone, so exec leaves no trace of
	// having been pointed somewhere.
	const startup = await resolveStartup(vault, process.cwd());

	if (cli.flags.propose) {
		if (cli.flags.out === undefined) {
			process.stderr.write('--propose needs --out <file>\n');
			process.exit(EXIT.usageError);
		}
		const [name, kind] = argv;
		if (name?.replace(/^\//, '') !== 'ingest' || kind === undefined) {
			process.stderr.write('--propose applies to /ingest <kind>\n');
			process.exit(EXIT.usageError);
		}
		report(
			await runPropose({
				root: startup.root,
				kind,
				out: cli.flags.out,
				version,
				focus: argv[2],
				again: cli.flags.again,
				now: new Date().toISOString(),
			}),
		);
	}

	report(
		await runExec({
			root: startup.root,
			argv,
			version,
			yes: cli.flags.yes,
			allowDerivedWrite: cli.flags.allowDerivedWrite,
		}),
	);
}

const startup = await resolveStartup(cli.input[0], process.cwd());
const {render} = await import('ink');
const {App} = await import('./app.js');

const {waitUntilExit} = render(
	<App root={startup.root} startup={startup} version={version} watch={cli.flags.watch} />,
	{
		// Tall output goes to the pager, so the dynamic region stays short and
		// incremental rendering keeps the composer off the redraw path.
		incrementalRendering: true,
		maxFps: 60,
	},
);

await waitUntilExit();

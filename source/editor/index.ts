export {
	buildCorpusMap,
	buildEditorContext,
	renderCorpusMap,
	selectRelevant,
} from './corpus.js';
export {
	buildCorrectionMessages,
	runCorrectionPass,
	type FixOutcome,
	type Refusal,
	type Target,
} from './fix.js';
export {
	guardCorrection,
	MAX_STRUCTURAL_EDITS,
	MAX_STRUCTURAL_RATIO,
	WORD_SIMILARITY_FLOOR,
} from './guard.js';
export {CORRECTION_PERSONA, CORRECTION_SHAPE, EDITOR_PERSONA} from './prompts.js';
export {EditorSession, type EditorSessionOptions} from './session.js';
export {resolveTargets, type TargetSelection} from './targets.js';
export type {
	CorpusEntry,
	CorpusMap,
	EditorRole,
	EditorTurn,
	GuardVerdict,
} from './types.js';

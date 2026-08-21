/**
 * A conversation between the author and one of the tool's agents.
 *
 * Shared rather than owned by either side: `/reviewer` and `/curator` are
 * different jobs over different material, but a turn is a turn, and they render
 * through the same screen. Naming these types after one of the two agents is
 * what made the curator import `ConversationTurn` — technically fine, and a small
 * lie about what the type is for.
 */

export type ConversationRole = 'author' | 'agent';

export type ConversationTurn = {
	readonly role: ConversationRole;
	readonly text: string;
};

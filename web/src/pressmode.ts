/*
The negotiation rule, and what each one means on the screen that sets it.

Two screens set it, the new game form and the game master's settings card, and
a table that reads one and then the other must not be told two different
things. The option name carries the phases. The line here carries what the name
cannot, which is what the app does with the words and who can read them.
*/
export type PressMode = "ftf" | "gunboat" | "rulebook" | "fullpress";

export const PRESS_HELP: Record<PressMode, string> = {
  ftf: "The app carries no messages.",
  gunboat: "The seats stay anonymous.",
  rulebook:
    "This is how a tournament board plays. Only the powers in a conversation " +
    "can read it. The server still knows who talks to whom, and when.",
  fullpress:
    "Best for a table that is not in one room. Only the powers in a " +
    "conversation can read it. The server still knows who talks to whom, " +
    "and when.",
};

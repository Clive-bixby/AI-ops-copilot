/**
 * Neutralise quoted-block tags inside untrusted text.
 *
 * Quoting data between block tags only helps if the data cannot close the tag
 * itself. A document, log line or ticket containing `</untrusted_evidence>` --
 * or `</context>` in the retrieval prompt -- followed by instructions would
 * otherwise end the quoted block and make the rest of its own text look like
 * prompt structure. Both tag families are stripped from the data, so the only
 * closing tag in a prompt is the one the prompt builder wrote.
 *
 * This is defence in depth, not a complete injection defence: content can still
 * steer the prose of an answer. What it cannot do is escape the quoted block.
 */
const QUOTED_BLOCK_TAG = /<\/?(?:untrusted_[a-z_]+|context)>/gi;

export function defangUntrustedText(value: string): string {
  return value.replace(QUOTED_BLOCK_TAG, "[tag removed]");
}

// A spoken answer to an approval on a call: yes or no, in English or Chinese.
//
// A speech recognizer returns Chinese without spaces, so the Chinese forms
// are matched as prefixes. Approving by voice runs real actions, so the
// Chinese "yes" is deliberately narrow: clear affirmatives only, a bare 好 / 是
// / 对 only as the whole answer, and the look-alikes ruled out — 好不好 and
// 可以吗 are questions, 不错 ("not bad") is not a refusal, and a hesitant 嗯
// ("um…") never approves anything.
const YES_EN = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO_EN = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;
const YES_ZH = /^(?:是的|好的|好啊|好吧|可以(?!吗|不)|同意|批准|允许|没问题|确认|行(?!不行|吗)|去吧|做吧|执行|(?:好|是|对|行)[。！!.]?$)/;
const NO_ZH = /^(?:不(?!错|客气|好意思)|别|否|拒绝|取消|停|算了)/;

export function spokenYes(said: string): boolean {
  const text = said.trim();
  return YES_EN.test(text) || YES_ZH.test(text);
}

export function spokenNo(said: string): boolean {
  const text = said.trim();
  return NO_EN.test(text) || NO_ZH.test(text);
}

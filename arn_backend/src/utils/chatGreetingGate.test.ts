import assert from "node:assert/strict";
import test from "node:test";
import { shouldAnswerChatWithoutRag } from "./chatGreetingGate.ts";

test("allows plain greetings and small talk", () => {
  const yes = [
    "hi",
    "Hi!",
    "  Hello  ",
    "hey there",
    "good morning",
    "how are you",
    "how are you?",
    "How's it going?",
    "what's up",
    "thanks",
    "thank you",
    "ok",
    "bye",
  ];
  for (const m of yes) {
    assert.equal(shouldAnswerChatWithoutRag(m), true, `expected true for: ${JSON.stringify(m)}`);
  }
});

test("rejects task-like or product questions (conservative RAG)", () => {
  const no = [
    "Hi, I need help with BRS",
    "hello what is the requirement",
    "hey how do i upload",
    "what is brs",
    "explain the pipeline",
    "error when uploading",
    "see the docs at https://x.com",
    "check `foo`",
    "email me @x.com",
    "brs question",
  ];
  for (const m of no) {
    assert.equal(shouldAnswerChatWithoutRag(m), false, `expected false for: ${JSON.stringify(m)}`);
  }
});

test("rejects long or empty input", () => {
  assert.equal(shouldAnswerChatWithoutRag(""), false);
  assert.equal(shouldAnswerChatWithoutRag("   "), false);
  const long = "hello ".repeat(20).trim();
  assert.equal(shouldAnswerChatWithoutRag(long), false);
});

test("rejects unknown short phrases", () => {
  assert.equal(shouldAnswerChatWithoutRag("maybe"), false);
  assert.equal(shouldAnswerChatWithoutRag("hi maybe"), false);
});

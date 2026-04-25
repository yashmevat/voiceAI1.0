const express = require("express");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

fs.mkdirSync("uploads", { recursive: true });

const app = express();
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const interviewSessions = new Map();

app.use(express.json({ limit: "1mb" }));

function parseJsonResponse(content, fallback) {
  try {
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function createJsonChatCompletion(messages, fallback) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content || "{}";
  return parseJsonResponse(content, fallback);
}

async function speakText(text) {
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text
  });

  return Buffer.from(await speech.arrayBuffer()).toString("base64");
}

async function safeSpeakText(text) {
  try {
    return await speakText(text);
  } catch (error) {
    console.error("TTS failed:", error?.message || error);
    return null;
  }
}

async function transcribeAudioFile(filePath, originalName, mimeType) {
  const audioFile = await OpenAI.toFile(
    fs.createReadStream(filePath),
    originalName,
    { type: mimeType }
  );

  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: "whisper-1"
  });

  return transcription.text || "";
}

async function generateQuestion(topic, history, questionNumber) {
  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are a strict but helpful VOICE interviewer for the field/domain: ${topic}. Ask exactly one question at a time. The question must be easy to answer verbally. Do not ask for typed code, punctuation-heavy syntax, or long written snippets. Prefer conceptual, scenario-based, and step-by-step explanation questions. Keep wording short, clear, and conversational. Return JSON with keys: question, topic, difficulty.`
      },
      {
        role: "user",
        content: JSON.stringify({
          topic,
          questionNumber,
          history
        })
      }
    ],
    {
      question: `Question ${questionNumber} for ${topic}`,
      topic: topic,
      difficulty: 5
    }
  );
}

async function makeVoiceFriendlyQuestion(topic, question) {
  const rewritten = await createJsonChatCompletion(
    [
      {
        role: "system",
        content: `Rewrite interview questions for voice conversation in the field/domain ${topic}. Keep the same intent but make it naturally speakable. Rules: short sentence, no code blocks, no request for exact syntax, no special symbols-heavy prompt. If the original asks to write code, convert it to explain approach verbally. Return JSON with key: question.`
      },
      {
        role: "user",
        content: JSON.stringify({ question })
      }
    ],
    {
      question: `${question} Please explain verbally, no code needed.`
    }
  );

  const speakable = String(rewritten.question || question || "").trim();
  if (speakable) {
    return speakable;
  }

  return `Please explain one practical concept related to ${topic}.`;
}

function fallbackQuestionText(topic) {
  return `Please explain one practical concept related to ${topic}.`;
}

async function finalAssessment(topic, history) {
  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are giving a final hiring-style assessment for an interview in the field/domain ${topic}. Decide whether the candidate is ready to work in this field/domain based on the conversation so far. Return JSON with keys: canProceed, verdict, overallScore, summary, strengths, gaps, recommendation.`
      },
      {
        role: "user",
        content: JSON.stringify({
          topic,
          history
        })
      }
    ],
    {
      canProceed: false,
      verdict: "needs practice",
      overallScore: 5,
      summary: "Unable to generate a final assessment.",
      strengths: [],
      gaps: [],
      recommendation: "Try again with clearer answers."
    }
  );
}

app.post("/api/interview/topic", upload.single("audio"), async (req, res) => {
  const audioPath = req.file?.path;
  const originalName = req.file?.originalname || "topic.webm";
  const mimeType = req.file?.mimetype || "audio/webm";

  if (!audioPath) {
    return res.status(400).json({ error: "Topic audio is required" });
  }

  try {
    const topicRaw = await transcribeAudioFile(audioPath, originalName, mimeType);
    const topic = topicRaw.trim().replace(/[.,!?]+$/g, "");

    if (!topic) {
      return res.status(400).json({ error: "Could not detect topic name" });
    }

    res.json({ topic });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to process topic audio" });
  } finally {
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
  }
});

app.post("/api/interview/start", async (req, res) => {
  try {
    const topic = (req.body?.topic || "").trim();

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    const firstQuestion = await generateQuestion(topic, [], 1);
    const voiceQuestion = await makeVoiceFriendlyQuestion(
      topic,
      firstQuestion.question || fallbackQuestionText(topic)
    );
    const questionAudio = await safeSpeakText(voiceQuestion);
    const interviewId = crypto.randomUUID();

    interviewSessions.set(interviewId, {
      topic,
      history: [],
      createdAt: Date.now()
    });

    res.json({
      interviewId,
      questionNumber: 1,
      question: voiceQuestion,
      questionAudio,
      topic: firstQuestion.topic,
      difficulty: firstQuestion.difficulty
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to start topic interview" });
  }
});

app.post("/api/interview/next", upload.single("audio"), async (req, res) => {
  try {
    const interviewId = (req.body?.interviewId || "").trim();
    const currentQuestion = (req.body?.currentQuestion || "").trim();
    const audioPath = req.file?.path;
    const originalName = req.file?.originalname || "answer.webm";
    const mimeType = req.file?.mimetype || "audio/webm";
    const session = interviewSessions.get(interviewId);

    if (!session) {
      return res.status(400).json({ error: "Interview session not found" });
    }

    if (!currentQuestion) {
      return res.status(400).json({ error: "Question is required" });
    }

    if (!audioPath) {
      return res.status(400).json({ error: "Audio answer is required" });
    }

    const currentAnswer = await transcribeAudioFile(audioPath, originalName, mimeType);

    if (!currentAnswer.trim()) {
      return res.status(400).json({ error: "Could not transcribe the audio answer" });
    }

    session.history.push({
      question: currentQuestion,
      answer: currentAnswer
    });

    const nextQuestionNumber = session.history.length + 1;

    let nextQuestion;
    try {
      const generated = await generateQuestion(
        session.topic,
        session.history,
        nextQuestionNumber
      );
      const voiceNextQuestion = await makeVoiceFriendlyQuestion(
        session.topic,
        generated.question || fallbackQuestionText(session.topic)
      );
      nextQuestion = {
        text: voiceNextQuestion,
        topic: generated.topic,
        difficulty: generated.difficulty
      };
    } catch (error) {
      console.error("Question generation failed:", error?.message || error);
      nextQuestion = {
        text: `Please explain one practical experience related to ${session.topic}.`,
        topic: session.topic,
        difficulty: 5
      };
    }

    const nextQuestionAudio = await safeSpeakText(nextQuestion.text);

    res.json({
      interviewId,
      questionNumber: nextQuestionNumber,
      history: session.history,
      currentAnswer,
      nextQuestion: nextQuestion.text,
      nextQuestionAudio,
      topic: nextQuestion.topic,
      difficulty: nextQuestion.difficulty
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to continue interview" });
  } finally {
    const audioPath = req.file?.path;
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
  }
});

app.post("/api/interview/finish", async (req, res) => {
  try {
    const interviewId = (req.body?.interviewId || "").trim();
    const session = interviewSessions.get(interviewId);

    if (!session) {
      return res.status(400).json({ error: "Interview session not found" });
    }

    if (!session.history.length) {
      return res.status(400).json({ error: "Answer at least one question before finishing" });
    }

    const assessment = await finalAssessment(session.topic, session.history);
    const assessmentAudio = await safeSpeakText(
      `${assessment.verdict}. ${assessment.summary} Recommendation: ${assessment.recommendation}.`
    );

    interviewSessions.delete(interviewId);

    res.json({
      topic: session.topic,
      history: session.history,
      assessment,
      assessmentAudio
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to finish interview" });
  }
});

// 🎤 Voice Interview API
app.post("/interview", upload.single("audio"), async (req, res) => {
  const audioPath = req.file?.path;
  const originalName = req.file?.originalname || "audio.webm";
  const mimeType = req.file?.mimetype || "audio/webm";

  if (!audioPath) {
    return res.status(400).send("No audio file uploaded");
  }

  try {
    const audioFile = await OpenAI.toFile(
      fs.createReadStream(audioPath),
      originalName,
      { type: mimeType }
    );

    // 1️⃣ Speech to Text (Whisper)
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1"
    });

    const userText = transcription.text;

    // 2️⃣ AI Interview + Evaluation
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a professional interviewer.

Ask next interview question AND evaluate user's answer.

Return response in JSON:
{
  "reply": "next question or response",
  "score": number (1-10),
  "grammar": number,
  "confidence": number,
  "technical": number,
  "feedback": "short feedback"
}
`
        },
        {
          role: "user",
          content: userText
        }
      ]
    });

    const content = aiResponse.choices[0].message.content;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {
        reply: content,
        score: 5,
        grammar: 5,
        confidence: 5,
        technical: 5,
        feedback: "Could not parse structured response"
      };
    }

    // 3️⃣ Text to Speech
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: parsed.reply
    });

    const audioBuffer = Buffer.from(await speech.arrayBuffer());

    // 4️⃣ Send Response
    res.json({
      userText,
      aiText: parsed.reply,
      scores: {
        score: parsed.score,
        grammar: parsed.grammar,
        confidence: parsed.confidence,
        technical: parsed.technical
      },
      feedback: parsed.feedback,
      audio: audioBuffer.toString("base64")
    });

  } catch (error) {
    console.error(error);
    res.status(500).send("Error processing interview");
  } finally {
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
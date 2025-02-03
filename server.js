const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require('dotenv');
const path = require('path');

const app = express();
dotenv.config();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// Google Auth Configuration
const credentials = {
    type: "service_account",
    project_id: process.env.GOOGLE_PROJECT_ID,
    private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    auth_uri: process.env.GOOGLE_AUTH_URI,
    token_uri: process.env.GOOGLE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_CERT_URL,
    client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL
};

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
        'https://www.googleapis.com/auth/forms',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.file'
    ]
});

async function createGoogleForm(formData) {
    try {
        const forms = google.forms({ version: 'v1', auth });
        
        // First, create the form with only the title
        const form = await forms.forms.create({
            requestBody: {
                info: {
                    title: formData.title
                }
            }
        });

        const formId = form.data.formId;

        // Then, use batchUpdate to add description and questions
        if (formId) {
            const batchUpdateRequest = {
                requests: []
            };

            // Add description if present
            if (formData.description) {
                batchUpdateRequest.requests.push({
                    updateFormInfo: {
                        info: {
                            description: formData.description
                        },
                        updateMask: 'description'
                    }
                });
            }

            // Add questions
            if (formData.questions?.length > 0) {
                formData.questions.forEach((question, index) => {
                    batchUpdateRequest.requests.push({
                        createItem: {
                            item: {
                                title: question.title,
                                questionItem: {
                                    question: {
                                        required: question.required ?? false,
                                        textQuestion: question.type === 'TEXT' ? {} : undefined,
                                        choiceQuestion: question.type === 'MULTIPLE_CHOICE' ? {
                                            options: question.options.map(opt => ({ value: opt })),
                                            type: 'RADIO'
                                        } : undefined
                                    }
                                }
                            },
                            location: { index }
                        }
                    });
                });
            }

            // Perform the batch update
            await forms.forms.batchUpdate({
                formId: formId,
                requestBody: batchUpdateRequest
            });
        }

        return `https://docs.google.com/forms/d/${formId}/viewform`;
    } catch (error) {
        console.error('Form creation error:', error.response?.data || error);
        throw new Error(`Failed to create Google Form: ${error.message}`);
    }
}

async function generateFormStructure(description) {
    try {
        const prompt = `Generate a Google Form structure based on this description: "${description}".
Return a JSON object (and nothing else) with exactly this structure:
{
    "title": "appropriate form title",
    "description": "brief form description",
    "questions": [
        {
            "title": "question text",
            "type": "TEXT or MULTIPLE_CHOICE",
            "required": true or false,
            "options": ["option1", "option2"] (include only for MULTIPLE_CHOICE)
        }
    ]
}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Clean up the response and parse JSON
        const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
        
        if (!jsonMatch) {
            throw new Error('No valid JSON found in response');
        }

        const formStructure = JSON.parse(jsonMatch[0]);

        // Validate structure
        if (!formStructure.title || !formStructure.questions || !Array.isArray(formStructure.questions)) {
            throw new Error('Invalid form structure generated');
        }

        return formStructure;
    } catch (error) {
        console.error('Gemini API Error:', error);
        throw new Error(`Failed to generate form structure: ${error.message}`);
    }
}

app.post('/api/generate-form', async (req, res) => {
    try {
        const { description } = req.body;
        
        if (!description) {
            return res.status(400).json({
                success: false,
                error: 'Form description is required'
            });
        }

        const formStructure = await generateFormStructure(description);
        const formUrl = await createGoogleForm(formStructure);

        res.json({ success: true, url: formUrl });
    } catch (error) {
        console.error('Error generating form:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
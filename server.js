const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Serve index.html from the same directory as server.js
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const chats = {}; // { chatId: { chatCode, userCode, users: [{ userId, username }], sockets } }
const chatCodeToChatId = {}; // { chatCode: chatId }
const userCodeToChatId = {}; // { userCode: chatId }

io.on('connection', (socket) => {
    socket.on('createChat', ({ userId, username }) => {
        const chatId = uuidv4();
        const chatCode = uuidv4().substring(0, 8); // Shortened UUID for chat
        const userCode = uuidv4().substring(0, 8); // Shortened UUID for user
        chats[chatId] = { 
            chatCode, 
            userCode, 
            users: [{ userId, username: username || 'Anonymous' }], 
            sockets: [socket.id] 
        };
        chatCodeToChatId[chatCode] = chatId;
        userCodeToChatId[userCode] = chatId;
        socket.join(chatId);
        socket.emit('chatCreated', { chatId, chatCode, userCode });
    });

    socket.on('joinChat', ({ chatCode, userCode, userId, username }) => {
        const chatId = chatCodeToChatId[chatCode];
        if (!chatId || !chats[chatId]) {
            socket.emit('error', 'Invalid or expired chat code.');
            return;
        }
        if (chats[chatId].userCode !== userCode) {
            socket.emit('error', 'Invalid user code.');
            return;
        }
        if (chats[chatId].users.length >= 3) {
            socket.emit('error', 'Chat room is full.');
            return;
        }
        if (!chats[chatId].users.some(u => u.userId === userId)) {
            chats[chatId].users.push({ userId, username: username || 'Anonymous' });
            chats[chatId].sockets.push(socket.id);
        }
        socket.join(chatId);
        io.to(chatId).emit('userOnline', { userId, username: username || 'Anonymous' });
        socket.emit('chatJoined', { chatId, users: chats[chatId].users });
    });

    socket.on('setUsername', ({ chatId, userId, username }) => {
        if (chats[chatId]) {
            const user = chats[chatId].users.find(u => u.userId === userId);
            if (user) {
                user.username = username;
                io.to(chatId).emit('userOnline', { userId, username });
            }
        }
    });

    socket.on('sendMessage', (msgData) => {
        io.to(msgData.chatId).emit('message', msgData);
    });

    socket.on('disconnect', () => {
        for (const chatId in chats) {
            const chat = chats[chatId];
            const userIndex = chat.sockets.indexOf(socket.id);
            if (userIndex !== -1) {
                const user = chat.users[userIndex];
                chat.sockets.splice(userIndex, 1);
                chat.users.splice(userIndex, 1);
                io.to(chatId).emit('userOffline', { userId: user.userId, username: user.username });
                if (chat.sockets.length === 0) {
                    delete chatCodeToChatId[chat.chatCode];
                    delete userCodeToChatId[chat.userCode];
                    delete chats[chatId];
                }
            }
        }
    });
});

// Use Render's assigned port or default to 3000 for local testing
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

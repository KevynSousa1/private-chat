const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const webPush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Serve index.html and service-worker.js
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/service-worker.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'service-worker.js'));
});

// VAPID keys for push notifications
const vapidKeys = {
    publicKey: 'BJvLVEoGQcyUsfpcwboH_2J1sPnW-pX9DqhRItzns1AbnfrV0nzR8xIMRhhd_pgMWnUlebBcppTiwKeG2Dcpl6Y', // Replace with your VAPID public key
    privateKey: '-npL4xaK4iD8qTYuLl0TBzxF8J9s4gAoMadq36DzS1U' // Replace with your VAPID private key
};
webPush.setVapidDetails(
    'contato.kevynporfirio@gmail.com', // Replace with your email
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

const chats = {}; // { chatId: { chatCode, userCode, chatName, users: [{ userId, username }], sockets, subscriptions: [{ userId, subscription }] } }
const chatCodeToChatId = {}; // { chatCode: chatId }
const userCodeToChatId = {}; // { userCode: chatId }

io.on('connection', (socket) => {
    socket.on('createChat', ({ userId, username }) => {
        const chatId = uuidv4();
        const chatCode = uuidv4().substring(0, 8);
        const userCode = uuidv4().substring(0, 8);
        const chatName = 'Private Chat';
        chats[chatId] = { 
            chatCode, 
            userCode, 
            chatName,
            users: [{ userId, username: username || 'Anonymous' }], 
            sockets: [socket.id],
            subscriptions: []
        };
        chatCodeToChatId[chatCode] = chatId;
        userCodeToChatId[userCode] = chatId;
        socket.join(chatId);
        socket.emit('chatCreated', { chatId, chatCode, userCode, chatName });
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
        socket.emit('chatJoined', { chatId, users: chats[chatId].users, chatName: chats[chatId].chatName });
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

    socket.on('setChatName', ({ chatId, chatName }) => {
        if (chats[chatId] && chatName.trim()) {
            chats[chatId].chatName = chatName.substring(0, 50);
            io.to(chatId).emit('chatNameUpdated', { chatName: chats[chatId].chatName });
        }
    });

    socket.on('subscribePush', ({ chatId, userId, subscription }) => {
        if (chats[chatId]) {
            chats[chatId].subscriptions = chats[chatId].subscriptions.filter(s => s.userId !== userId);
            chats[chatId].subscriptions.push({ userId, subscription });
        }
    });

    socket.on('sendMessage', async (msgData) => {
        io.to(msgData.chatId).emit('message', msgData);
        // Send push notifications to other users in the chat
        if (chats[msgData.chatId]) {
            const chatName = chats[msgData.chatId].chatName;
            const sender = chats[msgData.chatId].users.find(u => u.userId === msgData.userId);
            const notificationTitle = `${sender.username} in ${chatName}`;
            const notificationBody = msgData.message || (msgData.fileType === 'image' ? 'Sent an image' : 'Sent a file');
            for (const { userId, subscription } of chats[msgData.chatId].subscriptions) {
                if (userId !== msgData.userId) {
                    try {
                        await webPush.sendNotification(subscription, JSON.stringify({
                            title: notificationTitle,
                            body: notificationBody
                        }));
                    } catch (error) {
                        console.error('Push notification failed:', error);
                        // Remove expired subscriptions
                        chats[msgData.chatId].subscriptions = chats[msgData.chatId].subscriptions.filter(s => s.userId !== userId);
                    }
                }
            }
        }
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
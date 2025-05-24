const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const webPush = require('web-push');
const crypto = require('crypto');

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
    publicKey: process.env.VAPID_PUBLIC_KEY || 'BNxMSF8g57fv25doxz5C2CzociUlIwc03IMrXsIqbU1RHS_16dpt2054smZ19aXdBNy7mC5jZcrYvBwn0D0XwHQ',
    privateKey: process.env.VAPID_PRIVATE_KEY || 'zfbd7VmvKDphOcXo2Nsdcg9Cj2LsQ26w0p1dhxK1es0'
};
webPush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:contato.kevynporfirio@gmail.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);
console.log('VAPID configuration:', {
    publicKey: vapidKeys.publicKey,
    email: process.env.VAPID_EMAIL
});

const chats = {};
const chatCodeToChatId = {};
const userCodeToChatId = {};

// Hash password using SHA-256
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

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
            passwordHash: null,
            creatorId: userId,
            users: [{ userId, username: username || 'Anonymous' }],
            sockets: [socket.id],
            subscriptions: []
        };
        chatCodeToChatId[chatCode] = chatId;
        userCodeToChatId[userCode] = chatId;
        socket.join(chatId);
        socket.emit('chatCreated', { chatId, chatCode, userCode, chatName });
    });

    socket.on('joinChat', ({ chatCode, userCode, password, userId, username }) => {
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
        if (chats[chatId].passwordHash && hashPassword(password) !== chats[chatId].passwordHash) {
            socket.emit('passwordRequired');
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

    socket.on('setChatPassword', ({ chatId, userId, password }) => {
        if (chats[chatId] && chats[chatId].creatorId === userId) {
            chats[chatId].passwordHash = hashPassword(password);
            io.to(chatId).emit('passwordSet');
        } else {
            socket.emit('error', 'Only the chat creator can set a password.');
        }
    });

    socket.on('removeChatPassword', ({ chatId, userId, password }) => {
        if (chats[chatId] && chats[chatId].creatorId === userId) {
            if (chats[chatId].passwordHash && hashPassword(password) === chats[chatId].passwordHash) {
                chats[chatId].passwordHash = null;
                io.to(chatId).emit('passwordRemoved');
            } else {
                socket.emit('error', 'Incorrect password.');
            }
        } else {
            socket.emit('error', 'Only the chat creator can remove the password.');
        }
    });

    socket.on('subscribePush', ({ chatId, userId, subscription }) => {
        if (chats[chatId]) {
            chats[chatId].subscriptions = chats[chatId].subscriptions.filter(s => s.userId !== userId);
            chats[chatId].subscriptions.push({ userId, subscription });
            console.log(`Push subscription added for user ${userId} in chat ${chatId}`, {
                endpoint: subscription.endpoint,
                userId,
                chatId
            });
        } else {
            console.error(`subscribePush: Chat ${chatId} not found`);
            socket.emit('error', 'Chat not found for subscription.');
        }
    });

    socket.on('sendMessage', async (msgData) => {
        io.to(msgData.chatId).emit('message', msgData);
        if (chats[msgData.chatId]) {
            const chatName = chats[msgData.chatId].chatName;
            const sender = chats[msgData.chatId].users.find(u => u.userId === msgData.userId);
            const notificationTitle = `${sender.username} in ${chatName}`;
            const notificationBody = msgData.message || (msgData.fileType === 'image' ? 'Sent an image' : 'Sent a file');
            console.log(`Attempting to send notifications for chat ${msgData.chatId}`, {
                title: notificationTitle,
                body: notificationBody,
                subscriptions: chats[msgData.chatId].subscriptions.length
            });
            for (const { userId, subscription } of chats[msgData.chatId].subscriptions) {
                if (userId !== msgData.userId) {
                    try {
                        await webPush.sendNotification(subscription, JSON.stringify({
                            title: notificationTitle,
                            body: notificationBody
                        }));
                        console.log(`Notification sent to user ${userId}`, { endpoint: subscription.endpoint });
                    } catch (error) {
                        console.error(`Push notification failed for user ${userId}:`, error);
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

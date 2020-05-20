import * as express from 'express';
import * as bodyParser from 'body-parser';
import * as assert from 'assert';
import {v4 as uuidv4} from 'uuid';
import * as cookieParser from 'cookie-parser'
import * as crypto from 'crypto'
import {PrismaClient, AuthUser, AuthToken, Client} from '@prisma/client'
import {Express} from "express";

const prisma = new PrismaClient({
    datasources: {
        twitch_mock_oauth_server_ds: 'file:./twitch_mock_oauth_server_db.db' // need to specify this here.. I think? Need to look more into how this interacts with multiple datasources
    }
});

//TODO integrate http-errors

async function addClient(clientId: string, clientSecret: string): Promise<Client> {
    return await prisma.client.create({
        data: {
            clientId: clientId,
            clientSecretHash: crypto.createHash('sha256').update(clientSecret).digest('hex')
        }
    });
}

async function addOrGetUser(userName: string): Promise<AuthUser> {
    return prisma.authUser.upsert({
        create: {
            userName: userName,
            sessionId: uuidv4()
        },
        where: {
            userName: userName
        },
        update: {}
    });
}

async function clearDb(): Promise<void> {
    await prisma.authToken.deleteMany({});
    await prisma.authUser.deleteMany({});
    await prisma.client.deleteMany({});
}

//Generates a new token
async function generateToken(user: AuthUser, clientId: string, scope: string): Promise<AuthToken> {

    let client = await prisma.client.findOne({
        where: {
            clientId: clientId
        }
    });

    if (client === null) {
        throw new Error(`Cannot find client with id ${clientId}`);
    }

    let tokens = await prisma.authToken.findMany({
        where: {
            AND: [{
                issuedUser: user
            }, {
                issuedClientId: clientId
            }]
        }
    });

    return prisma.authToken.upsert({
        where: tokens && tokens.length >= 1 ? tokens[0] : {},
        create: {
            token: uuidv4(),
            refreshToken: uuidv4(),
            issuedClient: {
                connect: client
            },
            issuedUser: {
                connect: user
            },
            code: uuidv4(),
            expiry: new Date(Date.now() + 3600 * 1000),
            scope: scope
        },
        update: {
            token: uuidv4(),
            refreshToken: uuidv4(),
            code: uuidv4(),
            expiry: new Date(Date.now() + 3600 * 1000),
            scope: scope
        }
    });
}

type MockServerOptionsCommon = {
    token_url: string,
    authorize_url: string,
}

type MockServerOptionsExpressApp = {
    expressApp: Express,
} & MockServerOptionsCommon

type MockServerOptionsPort = {
    port: number
} & MockServerOptionsCommon

type MockServerOptions = MockServerOptionsPort | MockServerOptionsExpressApp

function setUpMockAuthServer(config: MockServerOptions) : Promise<void> {

    const OAUTH_URL = new URL(config.token_url);
    const OAUTH_AUTHORIZE_URL = new URL(config.authorize_url);

    const app = (config as MockServerOptionsExpressApp).expressApp ? (config as MockServerOptionsExpressApp).expressApp : express();

    app.use(cookieParser());
    app.use(bodyParser.urlencoded({
        extended: false
    }));


    app.post(OAUTH_URL.pathname, async (req, res) => {
        let url = new URL(req.originalUrl, `http://${req.header('hostname')}`);
        if (req.body.grant_type === 'authorization_code') {
            //Asking for auth token w/ code
            assert.ok(!!req.body.client_id);
            assert.ok(!!req.body.client_secret);
            assert.ok(!!req.body.code);
            assert.ok(!!req.body.redirect_uri);
            assert.ok(!!req.body.scope);
            //TODO: Verify code, send back token
            let token = await prisma.authToken.findMany({
                where: {
                    issuedClient: {
                        clientId: req.body.client_id,
                        clientSecretHash: crypto.createHash('sha256').update(req.body.client_secret).digest('hex')
                    },
                    code: req.body.code
                }
            });

            if (!token || token.length < 1) {
                throw new Error("No token associated with the client/secret/code combination.");
            }

            res.json({
                access_token: token[0].token,
                refresh_token: token[0].refreshToken,
                scope: token[0].scope && token[0].scope !== '' ? token[0].scope.split(' ') : [],
                expires_in: Math.floor((token[0].expiry.getTime() - Date.now()) / 1000),
                token_type: 'bearer'
            });

            res.end();

        } else if (req.body.grant_type === 'refresh_token') {
            //Asking for oauth token w/ refresh token
            assert.ok(!!req.body.client_id);
            assert.ok(!!req.body.client_secret);
            assert.ok(!!req.body.refresh_token);
            //TODO: Verify refresh token, send back new auth token / refresh token pair
            let tokens = await prisma.authToken.findMany({
                where: {
                    issuedClient: {
                        clientId: req.body.client_id,
                        clientSecretHash: crypto.createHash('sha256').update(req.body.client_secret).digest('hex')
                    },
                    refreshToken: req.body.refresh_token
                },
                include: {
                    issuedUser: true
                }
            });

            if (!tokens || tokens.length < 1) {
                throw new Error("No token associated with the client/secret/refresh token combination.");
            }

            let requestedScopes: string[];
            if (req.body.scope && req.body.scope !== '') {
                requestedScopes = req.body.scope.split(' ');
            } else {
                requestedScopes = tokens[0].scope && tokens[0].scope !== '' ? tokens[0].scope.split(' ') : [];
            }

            let oldScopes: string[] = tokens[0].scope && tokens[0].scope !== '' ? tokens[0].scope.split(' ') : [];

            requestedScopes.forEach((val) => {
                if (!oldScopes.includes(val)) {
                    throw new Error(`Requested scope is greater than the original scopes! (${val} was not originally requested)`);
                }
            });

            let token = await generateToken(tokens[0].issuedUser, req.body.client_id, requestedScopes.join(' '));

            res.json({
                access_token: token.token,
                refresh_token: token.refreshToken,
                scope: token.scope && token.scope !== '' ? token.scope.split(' ') : [],
                expires_in: Math.floor((token.expiry.getTime() - Date.now()) / 1000),
                token_type: 'bearer'
            });

            res.end();

        } else {
            throw new Error(`Bad grant type ${url.searchParams.get('grant_type')}`);
        }
    });

    app.post(OAUTH_AUTHORIZE_URL.pathname, async (req, res) => {
        let sessId = req.cookies.oauth_session;
        let url = new URL(req.originalUrl, `http://${req.header('hostname')}`);
        if (!sessId) {
            throw new Error('Bad session ID');
        }

        let user = await prisma.authUser.findOne({
            where: {
                sessionId: sessId
            }
        });

        if (!user) {
            throw new Error(`No user associated to session ${sessId}`);
        }

        assert.ok(!!url.searchParams.get('client_id'));
        assert.ok(!!url.searchParams.get('redirect_uri'));
        assert.ok(!!url.searchParams.get('response_type'));
        assert.ok(!!url.searchParams.get('scope'));

        let token = await generateToken(user, decodeURIComponent(<string>url.searchParams.get('client_id')), decodeURIComponent(<string>url.searchParams.get('scope')));

        let scopes: string[] = (decodeURIComponent(<string>url.searchParams.get('scope')).trim() === '') ? [] : decodeURIComponent(<string>url.searchParams.get('scope')).split(' ');

        //Always redirect; Typically the user would click a button here, but this is meant to be automated; So we assume the user presses yet
        //TODO: Possibly reject in some cases? I think twitch just redirects back to the original URL, but i'd need to confirm this behaviour
        res.redirect(307, `${decodeURIComponent(<string>url.searchParams.get('redirect_uri'))}` +
            `?access_token=${encodeURIComponent(token.token)}` +
            `&refresh_token=${encodeURIComponent(token.refreshToken)}` +
            `&expires_in=3600` +
            `&scope=${JSON.stringify(scopes)}` +
            `&token_type=bearer`);
    });

    app.post('/addOrGetUser/:username', async (req, res) => {
        if(!req.params.username){
            throw new Error(`Must specify username`);
        }
        let user = await addOrGetUser(req.params.username);
        res.json(user);
        res.end();
    });

    app.post('/addClient/:clientId/:clientSecret', async (req, res) => {
        if(!req.params.clientId){
            throw new Error(`Must specify clientId`);
        }

        if(!req.params.clientSecret){
            throw new Error(`Must specify clientSecret`);
        }

        await addClient(req.params.clientId, req.params.clientSecret);
        res.end();
    });

    if((config as MockServerOptionsPort).port){
        return new Promise((resolve, reject) => {
            app.listen((config as MockServerOptionsPort).port, resolve).on('error', reject);
        });
    }

    return Promise.resolve();
}

if(require.main === module){
    clearDb().then(() => {
        return setUpMockAuthServer({
            token_url: 'http://localhost:3080/token',
            authorize_url: 'http://localhost:3080/authorize',
            port: 3080
        });
    }).then(() => {
        console.log('Setup auth server; Listening on port 3080');
    });
}

export {
    addOrGetUser,
    addClient,
    clearDb,
    setUpMockAuthServer,
    MockServerOptions
}
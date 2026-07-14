// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React from 'react';
import './StreamComponent.css';
import * as gameliftstreamssdk from './gamelift-streams-websdk/gameliftstreams-1.2.0';
import NavBar from './NavBar';
import StatsOverlay, { StatsOverlayRef } from './StatsOverlay';
import { AuthContext } from './auth/AuthContext';

interface StreamComponentProps {
    signOut: any;
    user: any;
}

export enum StreamState {
    STOPPED = 1,
    LOADING,
    RUNNING,
    ERROR
}

interface StreamComponentState {
    status: StreamState;
    sgId: string;
    appId: string;
    sessionId: string;
    lastSessionId: string;
    regions: string[];
    inputEnabled: boolean;
    isStreamStarting: boolean;
    perfStats: any;
    micEnabled: boolean;
    speed: string;
    heartRate: string;
    calories: string;
    pipEnabled: boolean;
}

class StreamComponent extends React.Component<StreamComponentProps, StreamComponentState> {
    gameliftstreams?: gameliftstreamssdk.GameLiftStreams;
    private statsOverlayRef = React.createRef<StatsOverlayRef>();
    private micStatsInterval?: ReturnType<typeof setInterval>;

    constructor(props: StreamComponentProps) {
        super(props);

        this.state = {
            status: StreamState.STOPPED,
            sgId: 'sg-L8nff73L7',
            appId: 'a-GbN0XkXPi',
            sessionId: '',
            lastSessionId: '',
            regions: ['us-west-2'], // Must be supported Amazon GameLift Streams primary region (https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/regions-quotas-rande.html)
            inputEnabled: false,
            isStreamStarting: false,
            perfStats: {},
            micEnabled: false,
            speed: '0',
            heartRate: '0',
            calories: '0',
            pipEnabled: false
        };

        // Adding Stats to frontend
        this.performanceStatsCallback = this.performanceStatsCallback.bind(this);

        this.createStreamSession = this.createStreamSession.bind(this);
        this.createStreamSessionConnection = this.createStreamSessionConnection.bind(this);
        this.closeConnection = this.closeConnection.bind(this);
        this.handleInputChange = this.handleInputChange.bind(this);
        this.handleRegionChange = this.handleRegionChange.bind(this);
        this.enableFullScreen = this.enableFullScreen.bind(this);
    }

    componentDidMount(): void {
        this.resetGameLiftStreamsSDK();
    }

    private resetGameLiftStreamsSDK() {
        this.gameliftstreams = new gameliftstreamssdk.GameLiftStreams({
            videoElement: this.getVideoElement(),
            audioElement: this.getAudioElement(),
            inputConfiguration: {
                setCursor: 'visibility',
                autoPointerLock: 'fullscreen'
            },
            clientConnection: {
                /*
                // Connection callback handlers available if needed
                connectionState: this.streamConnectionStateCallback,
                channelError: this.streamChannelErrorCallback,
                serverDisconnect: this.streamServerDisconnectCallback
                */

                performanceStats: this.performanceStatsCallback // Adding Stats to frontend
            }
        });
    }

    private getVideoElement(): HTMLVideoElement {
        return document.getElementById(`StreamVideoElement`) as HTMLVideoElement;
    }

    private getAudioElement(): HTMLAudioElement {
        return document.getElementById(`StreamAudioElement`) as HTMLAudioElement;
    }

    private performanceStatsCallback(perfStats: any) {
        // console.log(`[Perf Stats] GameLift Streams Perf Stats`, perfStats);
        this.setState({ perfStats });
    }

    // --- Treadmill Data Channel ---
    private static textEncoder = new TextEncoder();

    private sendTreadmillMessage(message: string) {
        if (!this.gameliftstreams || !this.gameliftstreams.sendApplicationMessage(StreamComponent.textEncoder.encode(message))) {
            console.error('[Treadmill] Message failed to send.');
        }
    }

    private handleTreadmillChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = event.target;
        this.setState((prevState) => {
            const newState = { ...prevState, [name]: value };
            const speed = name === 'speed' ? value : prevState.speed;
            const heartRate = name === 'heartRate' ? value : prevState.heartRate;
            const calories = name === 'calories' ? value : prevState.calories;

            if (name === 'speed') {
                const speedKmh = parseFloat(speed) || 0;
                const gameSpeed = Math.max(1, Math.min(15, speedKmh * 0.75));
                this.sendTreadmillMessage(JSON.stringify({ action: 'setSpeed', speed: gameSpeed }));
            } else {
                this.sendTreadmillMessage(JSON.stringify({
                    action: 'updateStats',
                    heartRate: parseFloat(heartRate) || 0,
                    calories: parseFloat(calories) || 0
                }));
            }
            return newState;
        });
    };

    private handlePipToggle = () => {
        const newPipState = !this.state.pipEnabled;
        this.setState({ pipEnabled: newPipState });
        this.sendTreadmillMessage(JSON.stringify({ action: 'setPiP', active: newPipState }));
    };

    private toggleStats = () => {
        this.statsOverlayRef.current?.toggleStats();
    };

    /**
     * Sets the state for any kind of error - unwraps if error is of type ApiError.
     */
    private handleError(e: any) {
        console.log(e);
        this.setState({ isStreamStarting: false });
        alert(`Error: ${e.message || 'Unknown error'}. Check console for details.`);
    }

    /**
     * Sets timeout error in state.
     */
    private handleTimeout(arn: string) {
        const message = `Timeout in waiting for Stream Session: ${arn}`;
        console.error(`Polling timed out, ` + message);
        alert('Error: Stream session creation timed out. Check console for details.');
    }

    static contextType = AuthContext;
    context!: React.ContextType<typeof AuthContext>;

    private getApiEndpoint(): string {
        return this.context?.config.apiEndpoint ?? '';
    }

    private getIdToken(): string {
        return this.context?.idToken ?? '';
    }

    private async apiPost(path: string, body: any): Promise<any> {
        const resp = await fetch(`${this.getApiEndpoint()}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.getIdToken()}`,
            },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(`${resp.status} - ${errData.message || 'Unknown error'}`);
        }
        return resp.json();
    }

    private async apiGet(path: string): Promise<any> {
        const resp = await fetch(`${this.getApiEndpoint()}${path}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.getIdToken()}`,
            },
        });
        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(`${resp.status} - ${errData.message || 'Unknown error'}`);
        }
        return resp.json();
    }

    /**
     * Creates a new stream session using StartStream Lambda and then waits for it to be ready using @waitForACTIVE
     */
    private async createStreamSession() {
        this.setState({ isStreamStarting: true });
        if (this.state.micEnabled) {
            try {
                await this.gameliftstreams!.enableMicrophone();
                console.log('[Mic] Microphone enabled successfully');
            } catch (e) {
                console.error('[Mic] Failed to enable microphone:', e);
                alert('Failed to enable microphone. Please check browser permissions.');
                this.setState({ isStreamStarting: false });
                return;
            }
        }
        const signalRequest = await this.gameliftstreams?.generateSignalRequest();
        const payload = {
            AppIdentifier: this.state.appId,
            SGIdentifier: this.state.sgId,
            SignalRequest: signalRequest ?? '',
            Regions: this.state.regions
        };

        try {
            const data = await this.apiPost('/', payload);
            await this.waitForACTIVE(data.arn, this.state.sgId);
        } catch (e) {
            this.handleError(e);
        }
    }

    /**
     * Creates a new stream session connection for reconnection
     */
    private async createStreamSessionConnection() {
        this.setState({ isStreamStarting: true });
        if (this.state.micEnabled) {
            try {
                await this.gameliftstreams!.enableMicrophone();
                console.log('[Mic] Microphone enabled successfully');
            } catch (e) {
                console.error('[Mic] Failed to enable microphone:', e);
                alert('Failed to enable microphone. Please check browser permissions.');
                this.setState({ isStreamStarting: false });
                return;
            }
        }
        const signalRequest = await this.gameliftstreams?.generateSignalRequest();
        const payload = {
            SessionIdentifier: this.state.sessionId,
            SignalRequest: signalRequest ?? '',
        };

        try {
            const data = await this.apiPost('/reconnect', payload);
            await this.startStream(data.signalResponse);
        } catch (e) {
            this.handleError(e);
        }
    }

    /**
     * Waits for a stream session to be ready, polling a new stream sessions every second until its ready or times out.
     * This is more effective than having a Lambda function waiting for the session and potentially timing out.
     * This also allows for OnDemand scaling to work if a new session takes 30+ seconds to be ready.
     */
    async waitForACTIVE(arn: string, sg: string, timeoutMs: number = 600000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            console.log(`Waiting for stream session: ${arn}`);
            try {
                const data = await this.apiGet(`/session/${encodeURIComponent(sg)}/${encodeURIComponent(arn)}`);

                if (data.status === 'ACTIVE') {
                    await this.startStream(data.signalResponse);
                    this.setState((prevState) => ({
                        ...prevState,
                        lastSessionId: arn
                    }));
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                this.handleError(e);
                this.setState({ isStreamStarting: false });
                return;
            }
        }
        this.handleTimeout(arn);
        this.setState({ isStreamStarting: false });
    }

    private async startStream(signalResponse) {
        await this.gameliftstreams?.processSignalResponse(signalResponse);
        this.gameliftstreams?.attachInput();
        this.setState((prevState) => ({
            ...prevState,
            status: StreamState.RUNNING,
            isStreamStarting: false,
        }));

        if (this.state.micEnabled) {
            this.micStatsInterval = setInterval(async () => {
                try {
                    const stats = await this.gameliftstreams?.getMicrophoneRTCStats();
                    stats?.forEach((report: any) => {
                        if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                            console.log(`[Mic Stats] bytesSent=${report.bytesSent}, packetsSent=${report.packetsSent}`);
                        }
                    });
                } catch (e) {
                    console.error('[Mic Stats] Error:', e);
                }
            }, 3000);
        }
    }

    /**
     * Closes the connection and creates a new Amazon GameLift Streams Object as it can't be reused.
     */
    private closeConnection() {
        if (this.micStatsInterval) {
            clearInterval(this.micStatsInterval);
            this.micStatsInterval = undefined;
        }
        this.setState({status: StreamState.STOPPED, inputEnabled: false});
        this.gameliftstreams?.close();
        this.resetGameLiftStreamsSDK();
        this.setState({ isStreamStarting: false });

        if (document.fullscreenElement) {
            document.exitFullscreen().then();
        }
    }

    private enableFullScreen() {
        const element = this.getVideoElement()
        if (element) {
            this.gameliftstreams?.attachInput()
            this.setState({inputEnabled: true})
            element.requestFullscreen();
            // Use Keyboard API to set a "long hold" escape from fullscreen
            // if the browser supports this API (note that Safari does not)

            // @ts-ignore
            if (navigator.keyboard) {
                // @ts-ignore
                const keyboard = navigator.keyboard;
                keyboard.lock(["Escape"]);
            }
        }
    }

    private handleInputChange(event: React.ChangeEvent<HTMLInputElement>) {
        const { name, value } = event.target; // Extract name and value from input
        this.setState((prevState) => ({ ...prevState, [name]: value.trim() })); // Dynamically update state
    }

    private handleRegionChange(event: React.ChangeEvent<HTMLSelectElement>) {
        const region = event.target.value;
        this.setState((prevState) => ({
            ...prevState,
            regions: [region] // Update the regions array with the selected region
        }));
    }

    render() {
        return (
            <>
                {/* NavBar - Title and Sign Out */}
                <NavBar user={this.props.user} signOut={this.props.signOut} />

                {/* Input Fields and Buttons */}
                <div style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '20px',
                    padding: '0 20px',
                    marginTop:'20px',
                    flexWrap: 'wrap'
                }}>
                    <div>
                        Stream Group ID: <input type="text" name="sgId" onChange={this.handleInputChange} value={this.state.sgId}></input>
                    </div>
                    <div>
                        Application ID: <input type="text" name="appId" onChange={this.handleInputChange} value={this.state.appId}></input>
                    </div>
                    <div>
                        Region: <select onChange={this.handleRegionChange} value={this.state.regions[0]}>
                            <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
                            <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                            <option value="eu-west-1">eu-west-1 (Ireland)</option>
                            <option value="us-east-1">us-east-1 (N. Virginia)</option>
                            <option value="us-east-2">us-east-2 (Ohio)</option>
                            <option value="us-west-2">us-west-2 (Oregon)</option>
                        </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input
                                type="checkbox"
                                checked={this.state.micEnabled}
                                onChange={(e) => this.setState({ micEnabled: e.target.checked })}
                                disabled={this.state.status === StreamState.RUNNING}
                            />
                            🎤 Mic
                        </label>
                        <button
                            onClick={this.state.status !== StreamState.RUNNING ? this.createStreamSession : this.closeConnection}>
                            {this.state.status !== StreamState.RUNNING ? 'Start Stream' : 'End Stream'}
                        </button>
                        {this.state.isStreamStarting && <div className="spinner" />}
                    </div>
                    <div>
                        Stream Session ID: <input type="text" name="sessionId" onChange={this.handleInputChange}></input>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <button
                            onClick={this.createStreamSessionConnection}>
                            Reconnect
                        </button>
                        {this.state.isStreamStarting && <div className="spinner" />}
                    </div>
                    {this.state.status !== StreamState.RUNNING ? null :
                        <div className="fullscreen">
                            <button
                                className={'fullscreen-button'}
                                onClick={this.enableFullScreen}
                                disabled={this.state.status !== StreamState.RUNNING}
                            >Fullscreen</button>
                        </div>
                    }
                    {this.state.status !== StreamState.RUNNING ? null :
                        <div>
                            <button
                                onClick={this.toggleStats}
                                disabled={this.state.status !== StreamState.RUNNING}
                                style={{
                                    backgroundColor: this.statsOverlayRef.current?.isVisible ? '#ff9900' : '',
                                    color: this.statsOverlayRef.current?.isVisible ? 'white' : ''
                                }}
                            >Toggle Stats</button>
                        </div>
                    }
                    {
                        this.state.lastSessionId === '' ? null :
                        <div>
                            Last Session ID: {this.state.lastSessionId}
                        </div>
                    }
                </div>

                {/* Treadmill Data Channel Controls */}
                {this.state.status === StreamState.RUNNING && (
                    <div style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '20px',
                        padding: '0 20px',
                        marginTop: '10px',
                        flexWrap: 'wrap'
                    }}>
                        <div>
                            🏃 Speed (km/h): <input type="number" name="speed" value={this.state.speed} onChange={this.handleTreadmillChange} style={{ width: '80px' }} />
                        </div>
                        <div>
                            ❤️ Heart Rate: <input type="number" name="heartRate" value={this.state.heartRate} onChange={this.handleTreadmillChange} style={{ width: '80px' }} />
                        </div>
                        <div>
                            🔥 Calories: <input type="number" name="calories" value={this.state.calories} onChange={this.handleTreadmillChange} style={{ width: '80px' }} />
                        </div>
                        <div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={this.state.pipEnabled}
                                    onChange={this.handlePipToggle}
                                />
                                🖼️ Picture in Picture
                            </label>
                        </div>
                    </div>
                )}

                {/* Amazon GameLift Streams Video Element */}
                <div style={{
                    width: '100vw',
                    overflow: 'hidden',
                    position: 'relative',
                    marginLeft: 'calc(-50vw + 50%)',
                    marginRight: 'calc(-50vw + 50%)',
                    padding: '20px'
                }}>
                    <div style={{ position: 'relative' }}>
                        <video
                            id={'StreamVideoElement'}
                            autoPlay 
                            playsInline 
                            style={{
                                width: '100%',
                                height: 'auto',
                                display: 'block'
                            }}
                        />
                        <StatsOverlay
                            ref={this.statsOverlayRef}
                            gameliftstreams={this.gameliftstreams}
                            perfStats={this.state.perfStats}
                            isStreamRunning={this.state.status === StreamState.RUNNING}
                        />
                    </div>
                    <audio id={'StreamAudioElement'} autoPlay></audio>
                </div>
            </>
        );
    }
}

export default StreamComponent;

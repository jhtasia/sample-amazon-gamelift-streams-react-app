import StreamComponent from './StreamComponent';
import { AuthProvider, useAuth } from './auth/AuthContext';

const AUTH_CONFIG = {
    apiEndpoint: 'https://cjhwuepln2.execute-api.ap-northeast-1.amazonaws.com/prod'
};

function AppContent() {
    const { user, isLoading, signOut } = useAuth();

    if (isLoading) {
        return <div style={{ color: 'white', textAlign: 'center', marginTop: '100px' }}>驗證中...</div>;
    }

    if (!user) {
        // No valid sso_token_readable cookie found.
        // This means either:
        // 1. SSO flow hasn't completed (CloudFront domain not in allowedOrigins)
        // 2. Cookie expired mid-session
        // 3. Lambda@Edge version doesn't set sso_token_readable
        return (
            <div style={{ color: 'white', textAlign: 'center', marginTop: '100px', padding: '20px' }}>
                <p>無法讀取登入資訊。</p>
                <p style={{ fontSize: '14px', color: '#888', marginTop: '10px' }}>
                    請確認此 CloudFront domain 已加入 SSO Portal 的 allowedOrigins。
                </p>
                <button
                    onClick={() => window.location.reload()}
                    style={{ marginTop: '20px', padding: '10px 20px', cursor: 'pointer' }}
                >
                    重新整理
                </button>
            </div>
        );
    }

    return <StreamComponent signOut={signOut} user={user} />;
}

function App() {
    return (
        <AuthProvider config={AUTH_CONFIG}>
            <AppContent />
        </AuthProvider>
    );
}

export default App;

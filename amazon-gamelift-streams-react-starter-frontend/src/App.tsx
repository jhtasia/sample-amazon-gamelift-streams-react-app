import StreamComponent from './StreamComponent';
import '@aws-amplify/ui-react/styles.css';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';

Amplify.configure({
    Auth: {
        Cognito: {
            // example: 'us-west-2_CmhpQV4GR'
            userPoolId: 'ap-northeast-1_rO1hSldKS',
            // example: '5b9h9bmmmva3ig1trmq5n90orm'
            userPoolClientId: '3qqkf7grgb21dqki9c4hnrp5ul'
        }
    },
    API: {
        REST: {
            'demo-api': {
                // example: 'https://2ki03xizx7.execute-api.us-west-2.amazonaws.com/prod'
                // ensure the endpoint has no trailing slash '/' at the end
                endpoint: 'https://cjhwuepln2.execute-api.ap-northeast-1.amazonaws.com/prod'
            }
        }
    }
});


function App() {
    return (
        <Authenticator hideSignUp={true} loginMechanisms={['email']}>
            {({ signOut, user }) => (
                <StreamComponent signOut={signOut} user={user}></StreamComponent>
            )}
        </Authenticator>
    );
}

export default App;

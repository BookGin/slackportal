var config = {};

config.local_bot_token = 'xoxb-WORKSPACE_1_BOT_TOKEN';
config.local_oauth_token = 'xoxp-WORKSPACE_1_OAUTH_TOKEN';
config.local_channel_name = 'WORKSPACE_1_CHANNEL_NAME';

config.remote_bot_token = 'xoxb-WORKSPACE_2_BOT_TOKEN';
config.remote_oauth_token = 'xoxp-WORKSPACE_2_OAUTH_TOKEN';
config.remote_channel_name = 'WORKSPACE_2_CHANNEL_NAME';

//----------------------------------------------------------------------------------------

config.local_channel_name = config.local_channel_name.replace(/^#/, '');
config.remote_channel_name = config.remote_channel_name.replace(/^#/, '');
// NOTE: different workspace may have slight time difference in timestamp
// thus for one message, we cannot assert that local start_ts < remote start_ts
// Usually less than 1-2 seconds.
config.START_TS_DIFF = 3.0;
// The delay of forwarding messages to the remote. Usually less than 3-4 seconds.
config.END_TS_DIFF = 6.0;
// if the search result time difference is less than tolerance, show a warning message
config.TS_DIFF_TOLERANCE = 2.0;

module.exports = config;

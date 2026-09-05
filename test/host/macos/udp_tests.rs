//! `com_udp.rs` unit tests — 127.0.0.1 loopback only, no external network.
//! Mirrored under test/host/macos/ per repo convention; compiled into the
//! `pocketcom-host` bin via `#[path]` from host/macos/src/com_udp.rs.

use super::*;
use std::time::Duration;

#[path = "net_testutil.rs"]
mod util;

#[test]
fn open_param_validation_is_structured() {
    let reg = util::new_registry();
    for (bad, op) in [
        (udp_bind(&reg, "{not json"), "udpBind"),
        (udp_bind(&reg, r#"{"bindPort":0,"host":"","port":1}"#), "udpBind"),
        (udp_bind(&reg, r#"{"bindPort":0,"host":"h","port":0}"#), "udpBind"),
    ] {
        assert!(
            bad.contains("invalid-param"),
            "{op} should reject with a structured param error, got {bad}"
        );
    }
}

#[test]
fn udp_loopback_flow() {
    let reg = util::new_registry();
    // Peer socket (the "device") on an ephemeral port. The TEST plays the
    // echo itself (recv → send_to back): a separate echo thread would race
    // the test for packets on the same endpoint.
    let peer = UdpSocket::bind("127.0.0.1:0").unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let peer_port = peer.local_addr().unwrap().port();

    let opened = udp_bind(&reg, &format!(r#"{{"bindPort":0,"host":"127.0.0.1","port":{peer_port}}}"#));
    let handle = util::handle_of(&opened);
    let ev = util::wait_event(&reg, Duration::from_secs(5), &|v| {
        v["t"] == "opened" && v["h"] == handle
    })
    .expect("udp opened event");
    assert!(ev["addr"].as_str().unwrap().contains(&peer_port.to_string()));

    // host → peer write lands as a datagram from the worker's ephemeral port.
    assert!(reg.write(handle as i32, b"hello"));
    let mut buf = [0u8; 16];
    let (n, from) = peer.recv_from(&mut buf).expect("peer receives hello");
    assert_eq!(&buf[..n], b"hello");

    // peer → host reply: the connected socket only accepts packets from the
    // configured peer → data event.
    peer.send_to(b"hello", from).expect("reply");
    let data_ev = util::wait_event(&reg, Duration::from_secs(5), &|v| {
        v["t"] == "data" && v["h"] == handle
    })
    .expect("udp data event");
    assert_eq!(util::base64_decode(&data_ev["b64"].as_str().unwrap()), b"hello");
    assert!(reg.close(handle as i32));
}

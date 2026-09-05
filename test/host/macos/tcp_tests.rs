//! `com_tcp.rs` unit tests — 127.0.0.1 loopback only, no external network.
//! Mirrored under test/host/macos/ per repo convention; compiled into the
//! `pocketcom-host` bin via `#[path]` from host/macos/src/com_tcp.rs, so
//! `use super::*` reaches com_tcp's private items.

use super::*;
use std::io::Read as _;
use std::net::Shutdown;
use std::time::Duration;

#[path = "net_testutil.rs"]
mod util;

#[test]
fn open_param_validation_is_structured() {
    let reg = util::new_registry();
    for (bad, op) in [
        (tcp_connect(&reg, "{not json"), "tcpConnect"),
        (tcp_connect(&reg, r#"{"host":"","port":80}"#), "tcpConnect"),
        (tcp_connect(&reg, r#"{"host":"h","port":0}"#), "tcpConnect"),
        (tcp_connect(&reg, r#"{"host":"h"}"#), "tcpConnect"),
        (tcp_listen(&reg, "{not json"), "tcpListen"),
    ] {
        assert!(
            bad.contains("invalid-param"),
            "{op} should reject with a structured param error, got {bad}"
        );
    }
}

#[test]
fn ops_on_unknown_handles_are_false() {
    let reg = util::new_registry();
    assert!(!reg.write(99, b"x"));
    assert!(!reg.close(99));
    assert!(!reg.write(-1, b"x"));
    assert!(!reg.close(-1));
}

#[test]
fn tcp_loopback_full_flow() {
    let reg = util::new_registry();

    // 1. listen on an ephemeral port; the `opened` event carries the local addr.
    let opened = tcp_listen(&reg, r#"{"port":0}"#);
    let listener = util::handle_of(&opened);
    let opened_ev = util::wait_event(&reg, Duration::from_secs(5), &|v| {
        v["t"] == "opened" && v["h"] == listener
    })
    .expect("listener opened event");
    let local = opened_ev["addr"].as_str().unwrap().to_string();
    let port: u16 = local.rsplit(':').next().unwrap().parse().unwrap();

    // 2. a plain std client connects → accepted event, child usable.
    let mut client = TcpStream::connect(("127.0.0.1", port)).expect("client connect");
    client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let acc = util::wait_event(&reg, Duration::from_secs(5), &|v| {
        v["t"] == "accepted" && v["h"] == listener
    })
    .expect("accepted event");
    let child = acc["c"].as_u64().unwrap() as u32;
    assert!(
        acc["addr"].as_str().unwrap().starts_with("127.0.0.1:"),
        "accepted addr should be the peer address, got {}",
        acc["addr"].as_str().unwrap()
    );

    // 3. host→client write lands (write through the child handle).
    assert!(reg.write(child as i32, b"ping"));
    let mut buf = [0u8; 4];
    client.read_exact(&mut buf).expect("read ping");
    assert_eq!(&buf, b"ping");

    // 4. client→host write arrives as a data event (base64).
    use std::io::Write as _;
    client.write_all(b"pong").unwrap();
    let data_ev = util::wait_event(&reg, Duration::from_secs(5), &|v| {
        v["t"] == "data" && v["h"] == child
    })
    .expect("data event");
    assert_eq!(util::base64_decode(&data_ev["b64"].as_str().unwrap()), b"pong");

    // 5. kick: close(child) is host-initiated → no event (the guest drove
    // it, serial parity); the peer just sees EOF.
    assert!(reg.close(child as i32));
    assert_eq!(client.read(&mut buf).expect("read eof"), 0);

    // 6. closing the listener kills remaining children (map empties, peer EOF).
    let mut second = TcpStream::connect(("127.0.0.1", port)).expect("second client");
    let _ = util::wait_event(&reg, Duration::from_secs(5), &|v| {
        v["t"] == "accepted" && v["h"] == listener
    })
    .expect("second accepted");
    assert!(reg.close(listener as i32));
    // Wait for the child worker to observe Shutdown, then the map is empty.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while reg.has_connections() {
        assert!(
            std::time::Instant::now() < deadline,
            "listener close must tear down its children"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    // The second client's socket gets shut down.
    second.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    assert!(matches!(second.read(&mut buf), Ok(0) | Err(_)));
}

#[test]
fn tcp_connect_failure_is_async_error_then_closed() {
    let reg = util::new_registry();
    // Port 1 on 127.0.0.1 is refused immediately (nothing listens there).
    let opened = tcp_connect(&reg, r#"{"host":"127.0.0.1","port":1}"#);
    let handle = util::handle_of(&opened);
    // error + closed travel the same batch: wait on the accumulated set so
    // the first wait cannot drop the second event.
    let evs = util::wait_batch(&reg, Duration::from_secs(15), &|vs| {
        vs.iter().any(|v| v["t"] == "error" && v["h"] == handle)
    });
    let err = evs
        .iter()
        .find(|v| v["t"] == "error" && v["h"] == handle)
        .expect("error event");
    assert_eq!(err["code"], "io-error");
    let closed = evs
        .iter()
        .find(|v| v["t"] == "closed" && v["h"] == handle)
        .expect("closed event trails the error");
    assert!(closed["reason"].as_str().unwrap().contains("connecting"));
}

#[test]
fn listener_write_broadcasts_to_children() {
    let reg = util::new_registry();
    let opened = tcp_listen(&reg, r#"{"port":0}"#);
    let listener = util::handle_of(&opened);
    let ev = util::wait_event(&reg, Duration::from_secs(5), &|v| {
        v["t"] == "opened" && v["h"] == listener
    })
    .unwrap();
    let port: u16 = ev["addr"].as_str().unwrap().rsplit(':').next().unwrap().parse().unwrap();

    let mut c1 = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut c2 = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c1.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    c2.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    for _ in 0..2 {
        util::wait_event(&reg, Duration::from_secs(5), &|v| v["t"] == "accepted").unwrap();
    }
    assert!(reg.write(listener as i32, b"bc"));
    let mut buf = [0u8; 2];
    c1.read_exact(&mut buf).unwrap();
    c2.read_exact(&mut buf).unwrap();
    assert_eq!(&buf, b"bc");
    let _ = c1.shutdown(Shutdown::Both);
    let _ = c2.shutdown(Shutdown::Both);
    reg.close(listener as i32);
}

#[test]
fn handles_are_monotonic_across_ops() {
    // Handles allocate from one monotonic counter; two ops never repeat.
    let reg = util::new_registry();
    let h1 = util::handle_of(&tcp_connect(&reg, r#"{"host":"127.0.0.1","port":1}"#));
    // The failed connect still holds handle h1 until its worker exits; a
    // listener gets the next number.
    let h2 = util::handle_of(&tcp_listen(&reg, r#"{"port":0}"#));
    assert!(h2 > h1, "handles must be monotonic: {h1} then {h2}");
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CallActorForwarder
/// @notice Bridges an EOA-initiated send to the FEVM CallActor precompile.
/// @dev    The precompile at 0xfe00...0003 only behaves correctly when
///         invoked via DELEGATECALL from a contract (the CALLER's f410f
///         actor becomes the "from" of the cross-actor send and the
///         msg.value is forwarded). When called via plain CALL from an
///         EOA the precompile returns success but silently retains the
///         value at its own account. This forwarder exists solely to
///         provide that delegatecall context.
contract CallActorForwarder {
    address constant CALL_ACTOR_PRECOMPILE = 0xfe00000000000000000000000000000000000003;
    error ForwardFailed(bytes data);

    /// @notice Send msg.value to a Filecoin actor identified by `target`
    ///         (raw protocol-byte + payload bytes, e.g. [0x03, ...48 bytes]
    ///         for a t3 BLS address).
    function sendFil(bytes calldata target) external payable {
        bytes memory input = abi.encode(
            uint64(0),       // method_num = 0 (Send)
            msg.value,       // value
            uint64(0),       // send_flags = 0
            uint64(0),       // codec = 0 (no params)
            new bytes(0),    // raw_request
            target           // target_addr bytes
        );
        (bool ok, bytes memory ret) = CALL_ACTOR_PRECOMPILE.delegatecall(input);
        if (!ok) revert ForwardFailed(ret);
    }

    receive() external payable {}
}

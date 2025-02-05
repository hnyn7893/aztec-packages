import { CircuitsWasm, PrivateHistoricTreeRoots, ReadRequestMembershipWitness, TxContext } from '@aztec/circuits.js';
import { computeCommitmentNonce } from '@aztec/circuits.js/abis';
import { AztecAddress } from '@aztec/foundation/aztec-address';
import { Fr, Point } from '@aztec/foundation/fields';

import {
  ACVMField,
  fromACVMField,
  toACVMField,
  toAcvmCommitmentLoadOracleInputs,
  toAcvmL1ToL2MessageLoadOracleInputs,
} from '../acvm/index.js';
import { PackedArgsCache } from '../packed_args_cache.js';
import { DBOracle, NoteData } from './db_oracle.js';
import { pickNotes } from './pick_notes.js';

/**
 * The execution context for a client tx simulation.
 */
export class ClientTxExecutionContext {
  // Note: not forwarded to nested contexts via `extend()` because these witnesses
  // are meant to be maintained on a per-call basis as they should mirror read requests
  // output by an app circuit via public inputs.
  private readRequestPartialWitnesses: ReadRequestMembershipWitness[] = [];

  constructor(
    /**  The database oracle. */
    public db: DBOracle,
    /** The tx nullifier, which is also the first nullifier. This will be used to compute the nonces for pending notes. */
    private txNullifier: Fr,
    /** The tx context. */
    public txContext: TxContext,
    /** The old roots. */
    public historicRoots: PrivateHistoricTreeRoots,
    /** The cache of packed arguments */
    public packedArgsCache: PackedArgsCache,
    /** Pending commitments created (and not nullified) up to current point in execution **/
    private pendingNotes: NoteData[] = [],
  ) {}

  /**
   * Create context for nested executions.
   * @returns ClientTxExecutionContext
   */
  public extend() {
    return new ClientTxExecutionContext(
      this.db,
      this.txNullifier,
      this.txContext,
      this.historicRoots,
      this.packedArgsCache,
      this.pendingNotes,
    );
  }

  /**
   * For getting accumulated data.
   * @returns An array of partially filled in read request membership witnesses.
   */
  public getReadRequestPartialWitnesses() {
    return this.readRequestPartialWitnesses;
  }

  /**
   * For getting secret key.
   * @param contractAddress - The contract address.
   * @param ownerX - The x coordinate of the owner's public key.
   * @param ownerY - The y coordinate of the owner's public key.
   * @returns The secret key of the owner.
   */
  public async getSecretKey(contractAddress: AztecAddress, ownerX: ACVMField, ownerY: ACVMField) {
    return toACVMField(
      await this.db.getSecretKey(contractAddress, new Point(fromACVMField(ownerX), fromACVMField(ownerY))),
    );
  }

  /**
   * Gets some notes for a contract address and storage slot.
   * Returns a flattened array containing real-note-count and note preimages.
   *
   * @remarks
   *
   * Check for pending notes with matching address/slot.
   * Real notes coming from DB will have a leafIndex which
   * represents their index in the private data tree.
   *
   * This function will populate this.readRequestPartialWitnesses which
   * here is just used to flag reads as "transient" (one in getPendingNotes)
   * or to flag non-transient reads with their leafIndex.
   * The KernelProver will use this to fully populate witnesses and provide hints to
   * the kernel regarding which commitments each transient read request corresponds to.
   *
   * @param contractAddress - The contract address.
   * @param storageSlot - The storage slot.
   * @param sortBy - An array of indices of the fields to sort.
   * @param sortOrder - The order of the corresponding index in sortBy. (1: DESC, 2: ASC, 0: Do nothing)
   * @param limit - The number of notes to retrieve per query.
   * @param offset - The starting index for pagination.
   * @param returnSize - The return size.
   * @returns Flattened array of ACVMFields (format expected by Noir/ACVM) containing:
   * count - number of real (non-padding) notes retrieved,
   * contractAddress - the contract address,
   * preimages - the real note preimages retrieved, and
   * paddedZeros - zeros to ensure an array with length returnSize expected by Noir circuit
   */
  public async getNotes(
    contractAddress: AztecAddress,
    storageSlot: ACVMField,
    sortBy: ACVMField[],
    sortOrder: ACVMField[],
    limit: number,
    offset: number,
    returnSize: number,
  ): Promise<ACVMField[]> {
    const storageSlotField = fromACVMField(storageSlot);

    // TODO(https://github.com/AztecProtocol/aztec-packages/issues/920): don't 'get' notes nullified in pendingNullifiers
    const pendingNotes = this.pendingNotes.filter(
      n => n.contractAddress.equals(contractAddress) && n.storageSlot.equals(storageSlotField),
    );

    const dbNotes = await this.db.getNotes(contractAddress, storageSlotField);

    const notes = pickNotes([...pendingNotes, ...dbNotes], {
      sortBy: sortBy.map(field => +field),
      sortOrder: sortOrder.map(field => +field),
      limit,
      offset,
    });

    // Combine pending and db preimages into a single flattened array.
    const preimages = notes.flatMap(({ nonce, preimage }) => [nonce, ...preimage]);

    // Add a partial witness for each note.
    // It contains the note index for db notes. And flagged as transient for pending notes.
    notes.forEach(({ index }) => {
      this.readRequestPartialWitnesses.push(
        index !== undefined ? ReadRequestMembershipWitness.empty(index) : ReadRequestMembershipWitness.emptyTransient(),
      );
    });

    const paddedZeros = Array(Math.max(0, returnSize - 2 - preimages.length)).fill(Fr.ZERO);
    return [notes.length, contractAddress, ...preimages, ...paddedZeros].map(v => toACVMField(v));
  }

  /**
   * Fetches the a message from the db, given its key.
   * @param msgKey - A buffer representing the message key.
   * @returns The l1 to l2 message data
   */
  public async getL1ToL2Message(msgKey: Fr): Promise<ACVMField[]> {
    const messageInputs = await this.db.getL1ToL2Message(msgKey);
    return toAcvmL1ToL2MessageLoadOracleInputs(messageInputs, this.historicRoots.l1ToL2MessagesTreeRoot);
  }

  /**
   * Fetches a path to prove existence of a commitment in the db, given its contract side commitment (before silo).
   * @param contractAddress - The contract address.
   * @param commitment - The commitment.
   * @returns The commitment data.
   */
  public async getCommitment(contractAddress: AztecAddress, commitment: ACVMField) {
    const commitmentInputs = await this.db.getCommitmentOracle(contractAddress, fromACVMField(commitment));
    // TODO(https://github.com/AztecProtocol/aztec-packages/issues/1029): support pending commitments here
    this.readRequestPartialWitnesses.push(ReadRequestMembershipWitness.empty(commitmentInputs.index));
    return toAcvmCommitmentLoadOracleInputs(commitmentInputs, this.historicRoots.privateDataTreeRoot);
  }

  /**
   * Process new note created during execution.
   * @param contractAddress - The contract address.
   * @param storageSlot - The storage slot.
   * @param preimage - new note preimage.
   */
  public async pushNewNote(contractAddress: AztecAddress, storageSlot: ACVMField, preimage: ACVMField[]) {
    const wasm = await CircuitsWasm.get();
    const nonce = computeCommitmentNonce(wasm, this.txNullifier, this.pendingNotes.length);
    this.pendingNotes.push({
      contractAddress,
      storageSlot: fromACVMField(storageSlot),
      nonce,
      preimage: preimage.map(f => fromACVMField(f)),
    });
  }
}
